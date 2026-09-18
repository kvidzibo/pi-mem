import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  let inspection: MemoryStore | undefined;
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
    assert.deepEqual(tool.parameters.properties.action.enum, ["add", "supersede", "archive"]);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["action", "basis", "evidence", "id", "text"]);
    inspection = new MemoryStore(process.env.PI_MEMORY_DB);
    const execute = async (params: object, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, ctx);
    const input = { action: "add", text: "Test startup recall.", evidence: "Verified in the lifecycle smoke test.", basis: "validated_fix" };
    assert.match((await event("before_agent_start", { systemPrompt: "Base prompt" })).systemPrompt,
      /Maximum 20 words per lesson and 20 words for evidence/);
    const saved = JSON.parse((await execute(input)).content[0].text);
    assert.equal(saved.status, "saved");
    assert.equal(JSON.parse((await execute(input)).content[0].text).status, "already exists");
    assert.match(JSON.stringify(tool.parameters.properties.basis), /"validated_learning"/);
    const learned = JSON.parse((await execute({ ...input, basis: "validated_learning",
      text: "Build assets before packaging.", evidence: "Verified the build dependency." })).content[0].text);
    assert.equal(learned.status, "saved");
    const original = inspection.get(ctx.cwd, learned.id);
    assert.equal(original.basis, "validated_learning");
    const user = { role: "user", content: "Continue", timestamp: 1 };
    let recall = await event("context", { messages: [user] });
    assert.match(recall.messages[0].content, /Test startup recall/);
    recall = await event("context", recall);
    assert.equal(recall.messages.length, 2, "repeated requests must not accumulate memory blocks");
    inspection.archive(ctx.cwd, saved.id);
    recall = await event("context", { messages: [user] });
    assert.doesNotMatch(recall.messages[0].content, /Test startup recall/);
    for (const action of ["get", "list", "search", "history", "update", "restore"]) {
      await assert.rejects(execute({ ...input, action, id: saved.id, query: "startup" }), /Unknown memory action/);
    }
    const replacement = JSON.parse((await execute({ ...input, action: "supersede", id: learned.id,
      text: "Replacement lesson.", evidence: "Verified replacement." })).content[0].text);
    assert.equal(replacement.status, "superseded");
    assert.equal(replacement.supersedes_id, learned.id);
    assert.notEqual(replacement.id, learned.id);
    assert.deepEqual(inspection.get(ctx.cwd, learned.id),
      { ...original, archived: true, archived_at: inspection.get(ctx.cwd, replacement.id).created_at });
    await assert.rejects(execute({ ...input, action: "supersede", id: learned.id }), /already archived/);
    await event("session_shutdown", { reason: "reload" });
    await event("session_start", { reason: "reload" });
    recall = await event("context", { messages: [] });
    assert.match(recall.messages[0].content, /Replacement lesson/);
    assert.doesNotMatch(recall.messages[0].content, /Test startup recall|Build assets before packaging|memory list\/search/);
    const command = extension.commands.get("memory");
    await command.handler(`get ${learned.id}`, ctx);
    assert.deepEqual(JSON.parse(notices.at(-1)!), inspection.get(ctx.cwd, learned.id));
    await command.handler("archived", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).total, 2);
    await command.handler("search Replacement", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).lessons[0].id, replacement.id);
    await command.handler(`restore ${learned.id}`, ctx);
    assert.match(notices.at(-1)!, /\/memory —/);
    assert.equal(inspection.get(ctx.cwd, learned.id).archived, true);
    ctx.cwd = join(directory, "other");
    await event("session_shutdown", { reason: "resume" });
    await event("session_start", { reason: "resume" });
    assert.doesNotMatch((await event("context", { messages: [] })).messages[0].content, /Replacement lesson/);
    await assert.rejects(execute({ ...input, action: "supersede", id: replacement.id }), /not found in this project/);
    await assert.rejects(execute({ action: "archive", id: replacement.id }), /not found in this project/);
    ctx.sessionManager.getSessionFile = () => undefined;
    await assert.rejects(execute(input), /Ephemeral sessions/);
    await assert.rejects(execute({ ...input, basis: "validated_learning" }), /Ephemeral sessions/);
    await assert.rejects(execute({ ...input, action: "supersede", id: replacement.id }), /Ephemeral sessions/);
    await assert.rejects(execute({ action: "archive", id: replacement.id }), /Ephemeral sessions/);
    ctx.hasUI = false;
    assert.equal(JSON.parse((await execute({ ...input, basis: "user_request" })).content[0].text).status, "saved");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await assert.rejects(execute({ ...input, basis: "user_request", text: "Must not save" }, controller.signal), /cancelled/);
    assert.equal(inspection.list(ctx.cwd).total, 1);
    ctx.hasUI = true;
    await command.handler("list", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).total, 1);
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
    await assert.rejects(execute({ ...input, basis: "user_request" }), /JSON/);
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
    await command.handler(`supersede ${compact.id} Compact replacements work.`, ctx);
    assert.match(notices.at(-1)!, /"status": "superseded"/);
    assert.equal(inspection.get(ctx.cwd, compact.id).text, "Compact evidence works.");
    assert.equal(inspection.get(ctx.cwd, compact.id).archived, true);
    const successor = JSON.parse(notices.at(-1)!);
    await command.handler(`archive ${successor.id}`, ctx);
    assert.equal(inspection.get(ctx.cwd, successor.id).archived, true);
    writeFileSync(join(ctx.cwd, "low evidence.md"), "- Compact imports work.\n");
    await command.handler("import low evidence.md", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).imported, 1, "generated import evidence must fit even when the filename contains spaces");
  } finally {
    await event("session_shutdown", { reason: "quit" });
    inspection?.close();
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
  let modelCalls = 0;
  const unexpectedDialogs: string[] = [];
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
      notify: (text: string) => notices.push(text), setStatus() {},
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
        if (title === "Import draft needs editing") {
          assert.deepEqual(choices, ["Cancel", "Edit draft"]);
          return "Cancel";
        }
        unexpectedDialogs.push(title);
        return choices[0];
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
    assert.match(diffs.at(-1)!, /Unstructured source → 2 proposed lessons/);
    assert.match(diffs.at(-1)!, /ORIGINAL SOURCE\n  # Legacy/);
    assert.ok(diffs.at(-1)!.includes(original.split("\n").map((line) => `  ${line}`).join("\n")));
    assert.match(diffs.at(-1)!, /PROPOSED LESSONS\nLesson 1 · Proposed · 6 words\n  Use nonblocking opens/);
    assert.match(diffs.at(-1)!, /Lesson 2 · Proposed · 5 words\n  Preserve distinct lessons/);
    assert.equal(observer.list(project).total, 0);
    assert.deepEqual(unexpectedDialogs, [], "cancelled imports must not open further dialogs");
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
    assert.equal(modelCalls, 6, "invalid drafts get at most two automatic correction passes");
    assert.match(notices.at(-2)!, /Import draft needs editing: .*exceeds 8 words.*Nothing imported\./);
    assert.match(notices.at(-1)!, /Import cancelled/);
    assert.equal(observer.list(project).total, 0, "invalid model output cannot partly save");
    draft = "- Use nonblocking opens before file-type validation.\n- Preserve distinct lessons during import.\n";
    choice = "edit";
    await command.handler("import", ctx);
    let result = JSON.parse(notices.at(-1)!);
    assert.equal(result.imported, 2);
    assert.equal(result.sourceRetained, true);
    assert.deepEqual(unexpectedDialogs, [], "approved imports must not offer source removal");
    assert.equal(result.backup, undefined);
    assert.equal(result.movedSource, undefined);
    assert.equal(result.cleanupError, undefined);
    assert.match(diffs.at(-1)!, /Keep historical lessons recoverable/);
    assert.match(diffs.at(-1)!, /PROPOSED LESSONS\nLesson 1/);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(observer.list(project).total, 2);

    draft = "- Use nonblocking opens before file-type validation.\n- Keep historical lessons recoverable.\n";
    await command.handler("import", ctx);
    result = JSON.parse(notices.at(-1)!);
    assert.equal(result.imported, 0);
    assert.equal(result.existing, 2);
    assert.equal(result.sourceRetained, true);
    assert.equal(readFileSync(file, "utf8"), original, "repeat imports must also preserve the source");
    assert.deepEqual(unexpectedDialogs, []);
    assert.deepEqual(readdirSync(project).filter((name) => name.startsWith(".pi-mem-backup-")), [], "imports must not create source backups");
    recall = await event("context", { messages: [] });
    assert.match(recall.messages[0].content, /Keep historical lessons recoverable/);
    assert.match(recall.messages[0].content, /Legacy Markdown memory/);
    assert.match(recall.messages[0].content, /historical details/);

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
        assert.match(component.render(24).join("\n"), /characters/, "End must reach the final lesson");
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
    assert.equal(observer.list(project).total, 2, "closing the preview is not import approval");

    ctx.mode = "rpc";
    choice = "approve";
    const bulk = Array.from({ length: 500 }, (_, i) => `- Imported lesson ${i}.`).join("\n") + "\n";
    writeFileSync(file, bulk);
    await command.handler("import", ctx);
    assert.ok(Buffer.byteLength(notices.at(-1)!) > 16384, "exercise reports beyond the usual display limit");
    result = JSON.parse(notices.at(-1)!);
    assert.equal(result.ids.length, 500);
    assert.equal(result.imported, 500);
    assert.equal(result.sourceRetained, true);
    assert.equal(readFileSync(file, "utf8"), bulk, "large imports must preserve the source too");
    assert.deepEqual(unexpectedDialogs, []);
    assert.deepEqual(readdirSync(project).filter((name) => name.startsWith(".pi-mem-backup-")), []);
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

test("lesson-list imports preserve counts and require repaired drafts to be reviewed before saving", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-counts-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ maxLessonWords: 8 }));
  const project = join(directory, "project");
  mkdirSync(project);
  const file = join(project, "MEMORY.md");
  const original = "# Lessons\n\n- Use nonblocking opens before file-type validation and keep every reviewed lesson intact.\n- Preserve distinct lessons during import.\n";
  const repaired = "- Use nonblocking opens before file-type validation.\n- Preserve distinct lessons during import.\n";
  const split = "- Use nonblocking opens.\n- Keep reviewed lessons intact.\n- Preserve distinct lessons during import.\n";
  writeFileSync(file, original);
  let draft = split;
  let modelCalls = 0;
  let invalidateOnModel = false;
  const replies: string[] = [];
  const requests: Array<{ markdown: string; previousDraft?: string; validationErrors?: string[] }> = [];
  const notices: string[] = [];
  const previews: string[] = [];
  const editPrefills: string[] = [];
  const edits: string[] = [];
  const decisions: Array<[string, string]> = [];
  let extension: Awaited<ReturnType<typeof load>>;
  let observer: MemoryStore | undefined;
  const ctx = {
    cwd: project, mode: "rpc", hasUI: true,
    model: { provider: "offline-test", id: "draft", maxTokens: 8192 },
    modelRegistry: { complete: async (_model: unknown, input: { systemPrompt: string; messages: Array<{ content: string }> }) => {
      modelCalls++;
      requests.push(JSON.parse(input.messages[0].content));
      assert.match(input.systemPrompt, /Never split, merge, add or remove items/);
      assert.match(input.systemPrompt, /Shorten every overlong lesson yourself/);
      if (invalidateOnModel) ctx.cwd = directory;
      return { stopReason: "stop", content: [{ type: "text", text: replies.shift() ?? draft }] };
    } },
    sessionManager: { getSessionId: () => "count-session", getSessionFile: () => "/temporary/session.jsonl" },
    ui: {
      notify: (text: string) => notices.push(text), setStatus() {},
      custom: async (factory: any): Promise<any> => {
        const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
        const { KeybindingsManager } = await import(pathToFileURL(join(dist, "core/keybindings.js")).href);
        const { initTheme } = await import(pathToFileURL(join(dist, "modes/interactive/theme/theme.js")).href);
        initTheme("dark", false); // BorderedLoader's key hints use Pi's global theme, initialized by the real TUI.
        return new Promise((resolve, reject) => {
          let component: any;
          const done = (value: unknown) => queueMicrotask(() => { component?.dispose?.(); resolve(value); });
          try {
            component = factory({ terminal: { rows: 80 }, requestRender() {} },
              { fg: (_color: string, text: string) => text }, new KeybindingsManager(), done);
            const rendered: string[] = component.render(200);
            assert.ok(rendered.every((line) => visibleWidth(line) <= 200));
            if (rendered[0].startsWith("Memory import preview")) {
              previews.push(rendered.slice(1, -2).join("\n"));
              component.handleInput("\r");
            }
          } catch (error) { component?.dispose?.(); reject(error); }
        });
      },
      editor: async (title: string, prefill: string) => {
        if (title.startsWith("Review")) { previews.push(prefill); return prefill; }
        assert.match(title, /^Edit draft/);
        editPrefills.push(prefill);
        assert.ok(edits.length, "unexpected editor");
        return edits.shift()!;
      },
      select: async (title: string, choices: string[]) => {
        const expected = decisions.shift();
        assert.ok(expected, `unexpected dialog: ${title}`);
        assert.ok(title.startsWith(expected[0]), title);
        assert.ok(choices.includes(expected[1]));
        if (title.startsWith("Save")) {
          assert.equal(choices[0], "Cancel");
          assert.equal(observer!.list(project).total, 0, "review and editing cannot save anything");
        }
        return expected[1];
      },
    },
  };
  const event = async (name: string) => {
    for (const handler of extension?.handlers.get(name) ?? []) await handler({}, ctx);
  };
  try {
    extension = await load();
    await event("session_start");
    observer = new MemoryStore(process.env.PI_MEMORY_DB);
    const command = extension.commands.get("memory");
    const run = async () => {
      await command.handler("import", ctx);
      assert.equal(decisions.length, 0, `all expected dialogs must be reached; last notice: ${notices.at(-1)}`);
      assert.equal(edits.length, 0);
    };
    decisions.push(["Import draft needs editing", "Cancel"]);
    await run();
    assert.equal(modelCalls, 3, "stop after the initial draft and two failed correction passes");
    assert.match(notices.at(-2)!, /Draft has 3 lessons; source has 2/);
    assert.equal(previews.length, 0, "split drafts cannot reach review or import approval");
    assert.equal(observer.list(project).total, 0);

    // Repair can itself need editing; later manual edits cannot bypass the count guard.
    const unsafeDraft = "- \u001b[31mUse nonblocking opens.\n- Preserve distinct lessons during import.\n";
    decisions.push(["Import draft needs editing", "Edit draft"], ["Import draft needs editing", "Edit draft"],
      ["Import draft needs editing", "Edit draft"], ["Save", "Edit draft"],
      ["Import draft needs editing", "Edit draft"], ["Save", "Cancel"]);
    edits.push(original, unsafeDraft, repaired, split, repaired);
    await run();
    assert.equal(modelCalls, 6, "manual repair must not restart the exhausted automatic correction budget");
    assert.equal(editPrefills[0], split, "the rejected draft must survive for editing");
    assert.equal(editPrefills[1], original, "overlong text must not be silently shortened");
    assert.equal(editPrefills[2], unsafeDraft.replace("\u001b", "\\u001b"), "invalid drafts must not send terminal controls to the editor");
    assert.equal(editPrefills[4], split, "manual count changes also need repair");
    assert.ok(notices.some((text) => /Import draft needs editing: .*exceeds 8 words/.test(text)));
    assert.equal(previews.length, 2, "each repaired edit must receive a fresh preview");
    for (const preview of previews) {
      assert.match(preview, /2 source lessons → 2 proposed lessons/);
      assert.match(preview, /Lesson 1 · Changed · 12 → 6 words\nBEFORE\n  Use nonblocking opens before file-type validation and keep every reviewed lesson intact\.\nAFTER\n  Use nonblocking opens before file-type validation\./);
      assert.match(preview, /Lesson 2 · Unchanged · 5 words/);
      assert.equal(preview.split("Preserve distinct lessons during import.").length - 1, 1);
    }
    assert.equal(observer.list(project).total, 0, "cancelling a repaired draft must not save");

    // Feed every numbered validation error back automatically, then enforce count preservation on the correction too.
    const overlong = original.replace("Preserve distinct lessons during import.", "Preserve distinct lessons during import and keep every source item intact.");
    replies.push(overlong, split, repaired);
    decisions.push(["Save", "Import 2 reviewed lessons"]);
    ctx.mode = "tui";
    await run();
    ctx.mode = "rpc";
    assert.equal(modelCalls, 9);
    assert.equal(replies.length, 0);
    assert.equal(requests[6].previousDraft, undefined, "each explicit import starts a fresh drafting request");
    assert.equal(requests[7].previousDraft, overlong);
    assert.deepEqual(requests[7].validationErrors, [
      "Lesson 1: text exceeds 8 words (12 whitespace-separated words); shorten and retry",
      "Lesson 2: text exceeds 8 words (11 whitespace-separated words); shorten and retry",
    ]);
    assert.equal(requests[8].previousDraft, split, "each correction uses the latest rejected draft");
    assert.match(requests[8].validationErrors!.join("\n"), /Draft has 3 lessons; source has 2/);
    assert.ok(requests.slice(6, 9).every((request) => request.markdown === original), "retain the original source for every correction");
    assert.equal(editPrefills.length, 5, "successful automatic correction must not open a manual editor");
    assert.equal(previews.length, 3);
    assert.equal(JSON.parse(notices.at(-1)!).imported, 2);
    assert.deepEqual(new Set([...observer.list(project).lessons].map((lesson) => lesson.text)),
      new Set(["Use nonblocking opens before file-type validation.", "Preserve distinct lessons during import."]));
    assert.equal(readFileSync(file, "utf8"), original);

    // Legacy entries over the storage character cap must still retain their source boundaries.
    writeFileSync(file, `- Use nonblocking ${"x".repeat(1201)}\n- Preserve distinct lessons during import.\n`);
    draft = split;
    decisions.push(["Import draft needs editing", "Cancel"]);
    await run();
    assert.match(notices.at(-2)!, /Draft has 3 lessons; source has 2/);
    assert.equal(modelCalls, 12);
    assert.equal(previews.length, 3);
    assert.equal(observer.list(project).total, 2);

    // A project/session invalidation during drafting must stop before any correction call or dialog.
    invalidateOnModel = true;
    await run();
    assert.equal(modelCalls, 13);
    assert.match(notices.at(-1)!, /Session or project changed/);
    assert.equal(previews.length, 3);
    assert.equal(observer.list(project).total, 2);
  } finally {
    await event("session_shutdown");
    observer?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
