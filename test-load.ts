import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { visibleWidth } from "@earendil-works/pi-tui";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryStore } from "./src/store.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));

async function load() {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const loader = join(dirname(entry), "core/extensions/loader.js");
  assert.ok(existsSync(loader), "run npm ci to install the pinned Pi test dependency");
  const { loadExtensions } = await import(pathToFileURL(loader).href);
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const result = await loadExtensions(manifest.pi.extensions.map((path: string) => join(ROOT, path)), ROOT);
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  return { ...result.extensions[0], runtime: result.runtime };
}

test("real Pi loader: immediate persistence, bounded replaceable recall, lifecycle, commands and failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-load-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    cwd: join(directory, "project"), hasUI: true, mode: "rpc",
    sessionManager: { getSessionId: () => "load-session", getSessionFile: (): string | undefined => "/temporary/session.jsonl" },
    ui: {
      notify: (text: string) => notices.push(text), setStatus: (_key: string, text?: string) => statuses.push(text),
      editor: async (_title: string, prefill: string) => prefill,
      select: async (title: string, choices: string[]) => title.startsWith("Save") ? choices.at(-1) : choices[0],
    },
  };
  mkdirSync(ctx.cwd);
  mkdirSync(join(directory, "other"));
  let extension: Awaited<ReturnType<typeof load>>;
  const event = async (name: string, value: object = {}) => {
    let result;
    for (const handler of extension?.handlers.get(name) ?? []) result = await handler(value, ctx);
    return result;
  };
  try {
    extension = await load();
    assert.deepEqual([...extension.tools.keys()], ["memory"]);
    assert.deepEqual([...extension.commands.keys()], ["memory"]);
    assert.equal(existsSync(process.env.PI_MEMORY_DB), false, "factory loading must not open a database");
    await event("session_start", { reason: "startup" });
    const tool = extension.tools.get("memory").definition;
    const execute = async (params: object, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, ctx);
    const input = { action: "add", text: "Test startup recall.", evidence: "Verified in the lifecycle smoke test.", basis: "validated_fix" };
    assert.match((await event("before_agent_start", { systemPrompt: "Base prompt" })).systemPrompt,
      /Maximum 20 words per lesson and 20 words for evidence/);
    const saved = JSON.parse((await execute(input)).content[0].text);
    assert.equal(saved.status, "saved");
    assert.equal(JSON.parse((await execute(input)).content[0].text).status, "already exists");
    const user = { role: "user", content: "Continue", timestamp: 1 };
    let recall = await event("context", { messages: [user] });
    assert.match(recall.messages[0].content, /Test startup recall/);
    recall = await event("context", recall);
    assert.equal(recall.messages.length, 2, "repeated requests must not accumulate memory blocks");
    const otherConnection = new MemoryStore(process.env.PI_MEMORY_DB);
    const archived = otherConnection.setArchived(ctx.cwd, saved.id, saved.revision, true);
    otherConnection.close();
    recall = await event("context", { messages: [user] });
    assert.doesNotMatch(recall.messages[0].content, /Test startup recall/);
    await execute({ action: "restore", id: saved.id, revision: archived.revision });
    await event("session_shutdown", { reason: "reload" });
    await event("session_start", { reason: "reload" });
    assert.match((await event("context", { messages: [] })).messages[0].content, /Test startup recall/);
    ctx.cwd = join(directory, "other");
    await event("session_shutdown", { reason: "resume" });
    await event("session_start", { reason: "resume" });
    assert.doesNotMatch((await event("context", { messages: [] })).messages[0].content, /Test startup recall/);
    await assert.rejects(execute({ action: "get", id: saved.id }), /not found in this project/);
    ctx.sessionManager.getSessionFile = () => undefined;
    await assert.rejects(execute(input), /Ephemeral sessions/);
    ctx.hasUI = false;
    assert.equal(JSON.parse((await execute({ ...input, basis: "user_request" })).content[0].text).status, "saved");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(execute({ ...input, basis: "user_request", text: "Must not save" }, controller.signal), /cancelled/);
    assert.equal(JSON.parse((await execute({ action: "list" })).content[0].text).total, 1);
    ctx.hasUI = true;
    const command = extension.commands.get("memory");
    await command.handler("add Saved by a command.", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).status, "saved");
    writeFileSync(join(ctx.cwd, "old.md"), "# Lessons\n\n- Imported explicitly.\n");
    await command.handler("import old.md", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).imported, 1);
    await command.handler("export exported.md", ctx);
    assert.match(readFileSync(join(ctx.cwd, "exported.md"), "utf8"), /Imported explicitly/);
    await command.handler("export exported.md", ctx);
    assert.match(notices.at(-1)!, /EEXIST/);
    await event("session_shutdown", { reason: "quit" });
    await event("session_shutdown", { reason: "quit" });
    delete process.env.PI_MEMORY_DB;
    writeFileSync(join(directory, "pi-mem.json"), "invalid JSON");
    await event("session_start", { reason: "startup" });
    assert.equal(statuses.at(-1), "memory unavailable");
    assert.match((await event("context", { messages: [user] })).messages[0].content, /Project memory unavailable/);
    await assert.rejects(execute({ action: "list" }));
    writeFileSync(join(ctx.cwd, "MEMORY.md"), "- Legacy fallback survives database initialization failure.\n");
    assert.match((await event("context", { messages: [] })).messages[0].content, /Legacy fallback survives/);
    const config = { databasePath: "db.sqlite3", maxLessonWords: 3, maxEvidenceWords: 4 };
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify(config));
    await command.handler("reload", ctx);
    assert.match(notices.at(-1)!, /Saved by a command/);
    assert.match((await event("before_agent_start", { systemPrompt: "Base prompt" })).systemPrompt,
      /Maximum 3 words per lesson and 4 words for evidence/);
    await assert.rejects(execute({ ...input, basis: "user_request", text: "Four words are rejected.", evidence: "Verified." }), /text exceeds 3 words/);
    await command.handler("add Four words are rejected.", ctx);
    assert.match(notices.at(-1)!, /text exceeds 3 words/);
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ ...config, maxRecallLessons: 1 }));
    await command.handler("reload", ctx);
    assert.match((await event("context", { messages: [user] })).messages[0].content, /1 of 3 active lessons loaded/);
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ ...config, maxEvidenceWords: 1 }));
    await command.handler("reload", ctx);
    await command.handler("add Compact evidence works.", ctx);
    assert.match(notices.at(-1)!, /"status": "saved"/, "command evidence must fit the smallest supported limit");
    const compact = JSON.parse(notices.at(-1)!);
    await command.handler(`edit ${compact.id} Compact edits work.`, ctx);
    assert.match(notices.at(-1)!, /"status": "updated"/);
    writeFileSync(join(ctx.cwd, "low evidence.md"), "- Compact imports work.\n");
    await command.handler("import low evidence.md", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).imported, 1, "generated import evidence must fit even when the filename contains spaces");
  } finally {
    await event("session_shutdown", { reason: "quit" });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("legacy recall and reviewed import preserve originals, require consent, and reject stale actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-review-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ maxLessonWords: 8 }));
  const project = join(directory, "project");
  mkdirSync(join(project, "src"), { recursive: true });
  execFileSync("git", ["init", "--quiet", project]);
  const file = join(project, "MEMORY.md");
  const original = "# Legacy\n\n- Open untrusted import paths nonblocking before checking their file type, because a blocking open hangs on named pipes.\n\n## More\nPreserve each distinct lesson rather than silently dropping historical details.\n";
  writeFileSync(file, original);
  const notices: string[] = [];
  const diffs: string[] = [];
  let choice: "cancel" | "approve" | "edit" | "stale" | "reload" = "cancel";
  let cleanup: "keep" | "remove" | "change" = "keep";
  let modelCalls = 0;
  let removalOffers = 0;
  let commitNoticeFails = false;
  let draft = "- Use nonblocking opens before file-type validation.\n- Preserve distinct lessons during import.\n";
  let extension: Awaited<ReturnType<typeof load>>;
  const ctx = {
    cwd: project, mode: "rpc", hasUI: true,
    model: { provider: "offline-test", id: "draft", maxTokens: 8192 },
    modelRegistry: { complete: async (_model: unknown, input: { messages: Array<{ content: string }> }) => {
      modelCalls++;
      assert.match(input.messages[0].content, /nonblocking/);
      return { stopReason: "stop", content: [{ type: "text", text: draft }] };
    } },
    sessionManager: { getSessionId: () => "review-session", getSessionFile: () => "/temporary/session.jsonl" },
    ui: {
      notify: (text: string) => {
        if (commitNoticeFails && text.startsWith("Import committed")) { commitNoticeFails = false; throw new Error("Commit notification failed"); }
        notices.push(text);
      }, setStatus() {},
      editor: async (title: string, prefill: string) => {
        if (title.startsWith("Review")) { diffs.push(prefill); return prefill; }
        return "- Use nonblocking opens before file-type validation.\n- Keep historical lessons recoverable.\n";
      },
      select: async (title: string, choices: string[]) => {
        if (title.startsWith("Save")) {
          assert.equal(choices[0], "Cancel");
          if (choice === "cancel") return choices[0];
          if (choice === "edit") { choice = "approve"; return "Edit draft"; }
          if (choice === "stale") writeFileSync(file, original + "- Concurrent lesson.\n");
          if (choice === "reload") { await event("session_shutdown"); await event("session_start"); }
          return choices.at(-1);
        }
        removalOffers++;
        assert.equal(choices[0], "Keep source file");
        if (cleanup === "change") writeFileSync(file, original + "- Changed after commit.\n");
        return cleanup === "keep" ? choices[0] : choices.at(-1);
      },
      custom: async (_factory: any): Promise<any> => { throw new Error("unexpected custom UI"); },
    },
  };
  const event = async (name: string, value: object = {}) => {
    let result;
    for (const handler of extension?.handlers.get(name) ?? []) result = await handler(value, ctx);
    return result;
  };
  let observer: MemoryStore | undefined;
  try {
    extension = await load();
    await event("session_start");
    observer = new MemoryStore(process.env.PI_MEMORY_DB);
    assert.equal(modelCalls, 0, "discovery must never make a model call");
    assert.equal(observer.list(project).total, 0, "discovery must not import anything");
    assert.match(notices.at(-1)!, /Legacy memory.*\/memory import MEMORY.md/);
    let recall = await event("context", { messages: [] });
    assert.match(recall.messages[0].content, /historical details/);
    assert.equal((await event("context", recall)).messages.length, 1);
    assert.equal(notices.filter((text) => text.startsWith("Legacy memory found")).length, 1);
    writeFileSync(file, original + "Changed historical context.\n");
    await event("context", { messages: [] });
    await event("context", { messages: [] });
    assert.equal(notices.filter((text) => text.startsWith("Legacy memory found")).length, 2, "re-warn once after content changes");
    writeFileSync(file, original);
    ctx.cwd = join(project, "src");
    assert.doesNotMatch((await event("context", { messages: [] })).messages[0].content, /historical details/);
    ctx.cwd = project;
    const command = extension.commands.get("memory");
    await command.handler("import", ctx);
    assert.equal(modelCalls, 1);
    assert.match(diffs.at(-1)!, /-- Open untrusted/);
    assert.match(diffs.at(-1)!, /\+- Use nonblocking/);
    assert.equal(observer.list(project).total, 0);
    assert.equal(removalOffers, 0, "cancelled imports must not offer deletion");
    assert.equal(readFileSync(file, "utf8"), original);

    choice = "stale";
    await command.handler("import", ctx);
    assert.match(notices.at(-1)!, /changed since preview/);
    assert.equal(observer.list(project).total, 0);
    writeFileSync(file, original);
    choice = "reload";
    await command.handler("import", ctx);
    assert.equal(observer.list(project).total, 0, "session teardown invalidates approval");

    choice = "approve";
    draft = `- ${"overlong ".repeat(12)}\n`;
    await command.handler("import", ctx);
    assert.match(notices.at(-1)!, /exceeds 8 words/);
    assert.equal(observer.list(project).total, 0, "invalid model output cannot partly save");
    draft = "- Use nonblocking opens before file-type validation.\n- Preserve distinct lessons during import.\n";
    choice = "edit";
    await command.handler("import", ctx);
    let result = JSON.parse(notices.at(-1)!);
    assert.equal(result.imported, 2);
    assert.equal(result.sourceRetained, true);
    assert.match(diffs.at(-1)!, /Keep historical lessons recoverable/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(observer.list(project).total, 2);

    draft = "- Use nonblocking opens before file-type validation.\n- Keep historical lessons recoverable.\n";
    commitNoticeFails = true;
    await command.handler("import", ctx);
    result = JSON.parse(notices.at(-1)!);
    assert.equal(result.existing, 2);
    assert.equal(result.sourceRetained, true);
    assert.match(result.cleanupError, /Commit notification failed/);
    cleanup = "change";
    await command.handler("import", ctx);
    result = JSON.parse(notices.at(-1)!);
    assert.equal(result.imported, 0);
    assert.equal(result.existing, 2);
    assert.match(result.cleanupError, /changed since preview/);
    assert.equal(result.sourceRetained, true);
    assert.match(readFileSync(file, "utf8"), /Changed after commit/);
    writeFileSync(file, original);
    cleanup = "remove";
    await command.handler("import", ctx);
    result = JSON.parse(notices.at(-1)!);
    assert.equal(result.sourceRetained, false);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(result.backup, "utf8"), original);
    assert.equal(statSync(dirname(result.backup)).mode & 0o777, 0o700);
    assert.deepEqual(execFileSync("git", ["-C", project, "check-ignore", result.backup, result.movedSource], { encoding: "utf8" }).trim().split("\n"),
      [result.backup, result.movedSource], "private recovery files must also be excluded from ordinary Git staging");
    assert.doesNotMatch(execFileSync("git", ["-C", project, "ls-files", "--others", "--exclude-standard"], { encoding: "utf8" }), /\.pi-mem-backup-/);
    recall = await event("context", { messages: [] });
    assert.match(recall.messages[0].content, /Keep historical lessons recoverable/);
    assert.doesNotMatch(recall.messages[0].content, /Legacy Markdown memory/);

    writeFileSync(file, "- A new lesson.\n- Render invisible \u200echaracters.\n");
    ctx.hasUI = false;
    const headless: Array<{ message: { customType: string }; options: { triggerTurn?: boolean } }> = [];
    extension.runtime.sendMessage = (message: { customType: string }, options: { triggerTurn?: boolean }) => headless.push({ message, options });
    await event("session_start");
    assert.equal(headless.length, 1);
    assert.equal(headless[0].message.customType, "pi-mem-legacy-warning");
    assert.equal(headless[0].options.triggerTurn, false, "a passive warning must not steer a running agent");
    await assert.rejects(command.handler("import", ctx), /requires TUI or RPC/);
    assert.equal(observer.list(project).total, 2);
    ctx.hasUI = true;
    ctx.mode = "tui";
    choice = "cancel";
    const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
    const { KeybindingsManager } = await import(pathToFileURL(join(dist, "core/keybindings.js")).href);
    const keys = new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" });
    ctx.ui.custom = async (factory: any) => {
      let result: unknown;
      const tui = { terminal: { rows: 12 }, requestRender() {} };
      const component = await factory(tui, { fg: (_color: string, text: string) => text }, keys, (value: unknown) => { result = value; });
      try {
        const first = component.render(24);
        assert.ok(first.every((line: string) => visibleWidth(line) <= 24));
        component.handleInput("\x1b[F");
        assert.match(component.render(24).join("\n"), /new lesson/);
        const wide = component.render(120).join("\n");
        assert.doesNotMatch(wide, /\u200e/);
        assert.match(wide, /\\u200e/);
        tui.terminal.rows = 8;
        assert.ok(component.render(12).every((line: string) => visibleWidth(line) <= 12));
        component.handleInput("\r");
        assert.equal(result, undefined, "the injected keybindings override Enter");
        component.handleInput("\x19");
        assert.equal(result, true);
        return result;
      } finally { component.dispose?.(); }
    };
    await command.handler("import", ctx);
    assert.equal(observer.list(project).total, 2, "closing the diff is not import approval");

    ctx.mode = "rpc";
    choice = "approve";
    const bulk = Array.from({ length: 500 }, (_, i) => `- Imported lesson ${i}.`).join("\n") + "\n";
    writeFileSync(file, bulk);
    await command.handler("import", ctx);
    assert.ok(Buffer.byteLength(notices.at(-1)!) > 16384, "exercise reports beyond the usual display limit");
    result = JSON.parse(notices.at(-1)!);
    assert.equal(result.ids.length, 500);
    assert.equal(result.imported, 500);
    assert.equal(result.sourceRetained, false);
    assert.equal(readFileSync(result.backup, "utf8"), bulk, "backup paths must survive large result reports");
    assert.equal(readFileSync(result.movedSource, "utf8"), bulk);
    assert.equal(observer.list(project).total, 502);
  } finally {
    await event("session_shutdown");
    observer?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
