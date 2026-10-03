import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GLOBAL_SCOPE, MemoryStore } from "./src/store.ts";
import { formatTokens, memoryContext } from "./src/presentation.ts";
import { buildAudit, stagedAudit } from "./src/audit.ts";
import { Backups } from "./src/backups.ts";

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
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionLog = SessionManager.inMemory(ROOT);
  result.runtime.appendEntry = sessionLog.appendCustomEntry.bind(sessionLog);
  return { ...result.extensions[0], runtime: result.runtime, sessionLog };
}

test("real Pi loader: immediate persistence, bounded recall snapshots, lifecycle, commands and failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-load-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    cwd: join(directory, "project"), hasUI: true, mode: "rpc",
    sessionManager: { getSessionId: () => "load-session", getSessionFile: (): string | undefined => "/temporary/session.jsonl",
      getEntries: (): SessionEntry[] => extension.sessionLog.getEntries(),
      getLeafId: () => extension.sessionLog.getLeafId(),
      getBranch: () => [{ type: "message", message: { role: "assistant", provider: "test-provider", model: "issuing-model",
        content: [{ type: "toolCall", id: "call", name: "memory", arguments: {} }] } }] },
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
  const expectStatus = (loaded: number, _total: number, text: string, added = 0, archived = 0) => {
    // Match Pi's documented character-count heuristic against the actual injected SQLite block.
    const tokens = formatTokens(Math.ceil(text.length / 4));
    const changes = [added ? `+${added}` : "", archived ? `-${archived}` : ""].filter(Boolean).join(" ");
    assert.equal(statuses.at(-1), `\x1b[0m 🧠 ${loaded}|0${changes ? ` (${changes})` : ""} ~${tokens} \x1b[0m`);
  };
  const savedEntries = (): CustomEntry[] => extension.sessionLog.getEntries().filter((entry: SessionEntry) => entry.type === "custom" && entry.customType === "pi-mem-saved");
  const event = async (name: string, value: object = {}) => {
    let result;
    for (const handler of extension?.handlers.get(name) ?? []) result = await handler(value, ctx);
    return result;
  };
  try {
    extension = await load();
    assert.deepEqual([...extension.tools.keys()], ["memory", "memory_audit"]);
    assert.deepEqual([...extension.commands.keys()], ["pi-mem"]);
    assert.equal(existsSync(process.env.PI_MEMORY_DB), false, "factory loading must not open a database");
    await event("session_start", { reason: "startup" });
    const emptyRecall = await event("context", { messages: [{ role: "user", content: "Initial check", timestamp: 0 }] });
    expectStatus(0, 0, emptyRecall.messages[0].content); // Empty recall still has framing overhead.
    const tool = extension.tools.get("memory").definition;
    assert.deepEqual(tool.parameters.properties.action.enum, ["add", "supersede", "archive", "set_priority"]);
    assert.equal(tool.parameters.properties.id.type, "integer");
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["action", "basis", "evidence", "id", "priority", "reason", "scope", "text"]);
    inspection = new MemoryStore(process.env.PI_MEMORY_DB);
    const execute = async (params: object, signal?: AbortSignal) => tool.execute("call", tool.prepareArguments(params), signal, undefined, ctx);
    const input = { action: "add", priority: 5, text: "Test startup recall.", evidence: "Verified in the lifecycle smoke test.", basis: "validated_fix" };
    assert.match((await event("before_agent_start", { systemPrompt: "Base prompt" })).systemPrompt,
      /Maximum 20 words per lesson and 20 words for evidence/);
    const saved = JSON.parse((await execute(input)).content[0].text);
    assert.equal(saved.status, "saved");
    const creation = inspection.history(ctx.cwd, saved.id).events[0];
    assert.equal(creation.actor, "model");
    assert.equal(creation.provider, "test-provider");
    assert.equal(creation.model, "issuing-model");
    const reprioritized = JSON.parse((await execute({ action: "set_priority", id: saved.id, priority: 3,
      reason: "Frequently recurring failure." })).content[0].text);
    assert.equal(reprioritized.priority, 3);
    const priorityEvent = inspection.history(ctx.cwd, saved.id).events.find((event) => event.reason === "Frequently recurring failure.");
    assert.equal(priorityEvent?.model, "issuing-model");
    await execute({ action: "set_priority", id: saved.id, priority: 5 });
    assert.equal(savedEntries().length, 1, "priority changes must not create saved/archive chat cards");
    for (const id of [true, "00000000-0000-4000-8000-000000000001"]) {
      await assert.rejects(execute({ action: "archive", id }), /id must be a positive safe integer/);
    }
    assert.equal(tool.prepareArguments({ action: "archive", id: `#${saved.id}` }).id, saved.id);
    assert.equal(inspection.get(ctx.cwd, saved.id).archived, false, "invalid IDs must not resolve to lesson #1");
    for (const priority of [0, 11, -1, 1.5, true, false, "1", null, [], {}]) {
      await assert.rejects(execute({ ...input, priority }), /priority must/);
    }
    await assert.rejects(execute({ ...input, priority: undefined }), /priority must/);
    assert.match(stripVTControlCharacters(statuses.at(-1)!), /^ 🧠 1\|0 \(\+1\) ~[\d,]+ $/, "saving refreshes the footer immediately");
    assert.equal(savedEntries().length, 1);
    assert.deepEqual(savedEntries()[0].data, [{ id: saved.id, text: input.text, supersedes_id: null }]);
    const renderer = extension.entryRenderers.get("pi-mem-saved");
    const cardTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text };
    const component = renderer(savedEntries()[0], { expanded: false }, cardTheme);
    assert.match(component.render(100).map((line: string) => line.trim()).join("\n"),
      new RegExp(`Memory added \\(\\+1\\)\\n#${saved.id}: Test startup recall\\.`));
    for (const width of [1, 12, 40]) {
      assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
    }
    assert.deepEqual(extension.sessionLog.buildSessionContext().messages, [], "save cards must never enter model context");
    assert.equal(JSON.parse((await execute(input)).content[0].text).status, "already exists");
    assert.equal(savedEntries().length, 1, "duplicates must not create chat entries");
    assert.match(statuses.at(-1)!, /\(\+1\)/);
    assert.match(JSON.stringify(tool.parameters.properties.basis), /"validated_learning"/);
    const learned = JSON.parse((await execute({ ...input, basis: "validated_learning",
      text: "Build assets before packaging.", evidence: "Verified the build dependency." })).content[0].text);
    assert.equal(learned.status, "saved");
    const original = inspection.get(ctx.cwd, learned.id);
    assert.equal(original.basis, "validated_learning");
    const user = { role: "user", content: "Continue", timestamp: 1 };
    let recall = await event("context", { messages: [user] });
    assert.match(recall.messages[0].content, /Test startup recall/);
    expectStatus(2, 2, recall.messages[0].content, 2);
    recall = await event("context", recall);
    assert.equal(recall.messages.length, 2, "repeated requests must not accumulate memory blocks");
    inspection.archive(ctx.cwd, saved.id);
    const cachedRecall = structuredClone(recall.messages);
    recall = await event("context", { messages: [user] });
    assert.deepEqual(recall.messages.slice(0, cachedRecall.length), cachedRecall);
    assert.match(recall.messages.at(-1).content, new RegExp(`No longer recalled; disregard earlier recalled versions: #${saved.id}\\.`));
    expectStatus(1, 1, memoryContext(inspection.recall(ctx.cwd)).text, 2); // External archives must not count as this session's actions.
    for (const action of ["get", "list", "search", "history", "update", "restore"]) {
      await assert.rejects(execute({ ...input, action, id: saved.id, query: "startup" }), /Unknown memory action/);
    }
    const replacement = JSON.parse((await execute({ ...input, action: "supersede", id: learned.id,
      text: "Replacement lesson.", evidence: "Verified replacement." })).content[0].text);
    assert.equal(replacement.status, "superseded");
    assert.equal(replacement.supersedes_id, learned.id);
    assert.notEqual(replacement.id, learned.id);
    assert.equal(savedEntries().length, 3);
    assert.deepEqual(savedEntries().at(-1)!.data, [{ id: replacement.id, text: "Replacement lesson.", supersedes_id: learned.id }]);
    assert.match(renderer(savedEntries().at(-1), { expanded: false }, cardTheme).render(120)
      .map((line: string) => line.trim()).join("\n"),
      new RegExp(`Memory replaced \\(\\+1 -1\\)\\n#${replacement.id} \\(replaces #${learned.id}\\): Replacement lesson\\.`));
    assert.deepEqual(inspection.get(ctx.cwd, learned.id),
      { ...original, archived: true, archived_at: inspection.get(ctx.cwd, replacement.id).created_at });
    await assert.rejects(execute({ ...input, action: "supersede", id: learned.id }), /already archived/);
    await event("session_shutdown", { reason: "reload" });
    await event("session_start", { reason: "reload" });
    recall = await event("context", { messages: [] });
    assert.match(recall.messages[0].content, /Replacement lesson/);
    assert.doesNotMatch(recall.messages[0].content, /Test startup recall|Build assets before packaging|memory list\/search/);
    expectStatus(1, 1, recall.messages[0].content, 3, 1);
    assert.equal(savedEntries().length, 3, "reload must not repeat save entries");
    ctx.sessionManager.getSessionId = () => "new-session";
    await event("session_start", { reason: "new" });
    expectStatus(1, 1, recall.messages[0].content);
    const older = inspection.add(ctx.cwd, { text: "Previously stored lesson.", evidence: "Verified.", basis: "user_request" },
      { harness: "pi", session: "older-session" }).lesson;
    const archived = JSON.parse((await execute({ action: "archive", id: older.id })).content[0].text);
    assert.equal(archived.changed, true);
    expectStatus(1, 1, recall.messages[0].content, 0, 1);
    const archiveCards = (): CustomEntry[] => ctx.sessionManager.getEntries().filter((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === "pi-mem-archived");
    assert.equal(archiveCards().length, 1);
    const archiveRenderer = extension.entryRenderers.get("pi-mem-archived");
    assert.match(archiveRenderer(archiveCards()[0], { expanded: false }, { fg: (_color: string, text: string) => text }).render(100)
      .map((line: string) => line.trimEnd()).join("\n"), new RegExp(`Memory archived \\(-1\\)\\n#${older.id}: Previously stored lesson\\.`));
    for (const id of [older.id, saved.id]) {
      assert.equal(JSON.parse((await execute({ action: "archive", id })).content[0].text).changed, false);
    }
    assert.equal(archiveCards().length, 1, "already archived records must not create activity or increment counters");
    await event("session_shutdown", { reason: "reload" });
    await event("session_start", { reason: "reload" });
    expectStatus(1, 1, recall.messages[0].content, 0, 1);
    assert.deepEqual(extension.sessionLog.buildSessionContext().messages, [], "archive cards must stay outside model context");
    ctx.sessionManager.getSessionId = () => "load-session";
    await event("session_start", { reason: "resume" });
    expectStatus(1, 1, recall.messages[0].content, 3, 1);
    const command = extension.commands.get("pi-mem");
    await command.handler(`history ${learned.id}`, ctx);
    assert.deepEqual(JSON.parse(notices.at(-1)!), inspection.history(ctx.cwd, learned.id, 0, 5));
    await command.handler(`get ${learned.id}`, ctx);
    assert.deepEqual(JSON.parse(notices.at(-1)!), inspection.get(ctx.cwd, learned.id));
    await command.handler(`get #${learned.id}`, ctx);
    assert.deepEqual(JSON.parse(notices.at(-1)!), inspection.get(ctx.cwd, learned.id));
    await command.handler("archived", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).total, 3);
    await command.handler("search Replacement", ctx);
    assert.equal(JSON.parse(notices.at(-1)!).lessons[0].id, replacement.id);
    await command.handler(`restore ${learned.id}`, ctx);
    assert.match(notices.at(-1)!, /\/pi-mem —/);
    assert.equal(inspection.get(ctx.cwd, learned.id).archived, true);
    ctx.cwd = join(directory, "other");
    await event("session_shutdown", { reason: "resume" });
    await event("session_start", { reason: "resume" });
    const otherRecall = await event("context", { messages: [] });
    assert.doesNotMatch(otherRecall.messages[0].content, /Replacement lesson/);
    expectStatus(0, 0, otherRecall.messages[0].content);
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
    assert.equal(savedEntries().length, 5, "headless tool and direct command saves are logged too");
    await event("session_shutdown", { reason: "quit" });
    await event("session_shutdown", { reason: "quit" });
    delete process.env.PI_MEMORY_DB;
    writeFileSync(join(directory, "pi-mem.json"), "invalid JSON");
    await event("session_start", { reason: "startup" });
    assert.equal(statuses.at(-1), "\x1b[0m 🧠 unavailable \x1b[0m");
    assert.match((await event("context", { messages: [user] })).messages[0].content, /Project memory unavailable/);
    await assert.rejects(execute({ ...input, basis: "user_request" }), /JSON/);
    writeFileSync(join(ctx.cwd, "MEMORY.md"), "- Legacy fallback survives database initialization failure.\n");
    assert.doesNotMatch((await event("context", { messages: [] })).messages[0].content, /Legacy fallback survives/);
    const config = { databasePath: "db.sqlite3", maxLessonWords: 3, maxEvidenceWords: 4 };
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify(config));
    await command.handler("reload", ctx);
    assert.match(notices.at(-1)!, /Saved by a command/);
    assert.doesNotMatch(notices.at(-1)!, /Legacy fallback survives/);
    assert.deepEqual(command.getArgumentCompletions("import"), []);
    assert.deepEqual(command.getArgumentCompletions("export"), []);
    assert.match((await event("before_agent_start", { systemPrompt: "Base prompt" })).systemPrompt,
      /Maximum 3 words per lesson and 4 words for evidence/);
    await assert.rejects(execute({ ...input, basis: "user_request", text: "Four words are rejected.", evidence: "Verified." }), /text exceeds 3 words/);
    await command.handler("add Four words are rejected.", ctx);
    assert.match(notices.at(-1)!, /text exceeds 3 words/);
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ ...config, maxRecallLessons: 1 }));
    await command.handler("reload", ctx);
    await event("session_compact");
    const sqliteRecall = (await event("context", { messages: [user] })).messages[0].content;
    assert.match(sqliteRecall, /^PROJECT LESSONS\nPriority: .*\nPriority guides .*\n- \[P5\] /);
    assert.match(sqliteRecall, /\n\[1 lessons omitted\.\]$/);
    assert.doesNotMatch(sqliteRecall, /evidence|scope|loaded|total/);
    expectStatus(1, 2, sqliteRecall, 2); // Omitted lessons do not inflate token counts.
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ ...config, maxRecallBytes: Buffer.byteLength(sqliteRecall) }));
    await command.handler("reload", ctx);
    await event("session_compact");
    const byteLimitedRecall = (await event("context", { messages: [user] })).messages[0].content;
    assert.equal(byteLimitedRecall, sqliteRecall, "the byte budget must apply even without a one-lesson count limit");
    assert.ok(Buffer.byteLength(byteLimitedRecall) <= Buffer.byteLength(sqliteRecall));
    expectStatus(1, 2, byteLimitedRecall, 2);
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ ...config, maxEvidenceWords: 1 }));
    await command.handler("reload", ctx);
    await event("session_compact");
    const restoredRecall = (await event("context", { messages: [user] })).messages[0].content;
    assert.doesNotMatch(restoredRecall, /lessons omitted/);
    expectStatus(2, 2, restoredRecall, 2);
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
    assert.match(statuses.at(-1)!, /\(\+4 -2\)/, "direct supersede and archive both count their retirements");
    await command.handler(`archive ${successor.id}`, ctx);
    assert.equal(JSON.parse(notices.at(-1)!).changed, false);
    assert.match(statuses.at(-1)!, /\(\+4 -2\)/);
    await command.handler("add --priority 0 Extreme human lesson.", ctx);
    const extreme = JSON.parse(notices.at(-1)!);
    assert.equal(inspection.get(ctx.cwd, extreme.id).priority, 0);
    const extremeReplacement = JSON.parse((await execute({ ...input, action: "supersede", id: extreme.id,
      text: "Corrected extreme lesson.", evidence: "Verified.", basis: "user_request", priority: 10 })).content[0].text);
    assert.equal(extremeReplacement.priority, 0);
    await assert.rejects(execute({ action: "set_priority", id: extremeReplacement.id, priority: 1, basis: "user_request" }), /user-reserved/);
    await command.handler(`priority ${extremeReplacement.id} 7`, ctx);
    assert.equal(inspection.get(ctx.cwd, extremeReplacement.id).priority, 7);
    await command.handler(`priority ${extremeReplacement.id} false`, ctx);
    assert.match(notices.at(-1)!, /Usage:/);
    assert.equal(inspection.get(ctx.cwd, extremeReplacement.id).priority, 7);
    await command.handler("global add Global CLI lesson.", ctx);
    await command.handler("global add Another CLI lesson.", ctx);
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ ...config, maxRecallLessons: 1 }));
    await command.handler("reload", ctx);
    const combined = (await event("context", { messages: [] })).messages[0].content;
    assert.match(combined, /^GLOBAL LESSONS[\s\S]*lessons omitted[\s\S]*PROJECT LESSONS[\s\S]*lessons omitted/);
    assert.equal(statuses.at(-1), `\x1b[0m 🧠 1|1 (+8 -3) ~${formatTokens(Math.ceil(combined.length / 4))} \x1b[0m`,
      "footer splits loaded scopes, combines changes/tokens, and hides omission totals");
  } finally {
    await event("session_shutdown", { reason: "quit" });
    inspection?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real Pi loader: lesson changes append deltas without rewriting earlier request prefixes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-cache-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  const extension = await load();
  const ctx = { cwd: directory, hasUI: false, sessionManager: {
    getSessionId: () => "cache-session", getEntries: () => [], getBranch: () => [],
  } };
  const event = async (name: string, value: object = {}) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(value, ctx);
    return result;
  };
  const db = new MemoryStore(process.env.PI_MEMORY_DB);
  const source = { harness: "test", session: "external" };
  const add = (text: string, scope = directory) => db.add(scope, { text, evidence: "Verified.", basis: "user_request" }, source).lesson;
  const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp });
  try {
    const original = add("Original project lesson.");
    const global = add("Global lesson.", GLOBAL_SCOPE);
    await event("session_start");
    let raw = [user("Start", 1)];
    let request = (await event("context", { messages: raw })).messages;
    assert.match(request[0].content, /GLOBAL LESSONS[\s\S]*Global lesson[\s\S]*PROJECT LESSONS[\s\S]*Original project/);
    const baseline = structuredClone(request[0]);
    const next = async (pattern: RegExp) => {
      const before = structuredClone(request);
      raw.push(user(`Continue ${raw.length}`, raw.length + 1));
      request = (await event("context", { messages: structuredClone(raw) })).messages;
      assert.deepEqual(request.slice(0, before.length), before, "the entire previous request must remain byte-for-byte unchanged");
      assert.match(request.at(-1).content, pattern);
      assert.deepEqual(request[0], baseline);
      assert.deepEqual((await event("context", { messages: structuredClone(raw) })).messages, request, "retries must not duplicate deltas");
      assert.deepEqual((await event("context", { messages: structuredClone(request) })).messages, request, "already-transformed input must be idempotent");
    };
    const added = add("New project lesson.");
    await next(/MEMORY UPDATE[\s\S]*New project lesson/);
    assert.doesNotMatch(request.at(-1).content, /Original project lesson|Global lesson\./, "unchanged lesson text must not be repeated");
    db.setPriority(directory, original.id, 2, source);
    await next(new RegExp(`\\[P2\\] Original project lesson\\. #${original.id}`));
    db.archive(GLOBAL_SCOPE, global.id);
    await next(new RegExp(`No longer recalled; disregard earlier recalled versions: #${global.id}`));
    const replacement = db.supersede(directory, added.id, { text: "Replacement lesson.", evidence: "Verified.", basis: "user_request" }, source);
    await next(new RegExp(`No longer recalled[^\\n]*#${added.id}[\\s\\S]*Replacement lesson\\. #${replacement.id}`));
    db.moveLesson(directory, original.id, GLOBAL_SCOPE, source);
    await next(/GLOBAL LESSONS\n- \[P2\] Original project lesson/);

    // Reloading limits keeps the baseline, but withdraws IDs displaced by the new selection.
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ maxRecallBytes: 64 }));
    extension.runtime.sendMessage = () => {};
    await extension.commands.get("pi-mem").handler("reload", ctx);
    await next(/No longer recalled[\s\S]*Current recall status:[\s\S]*lessons omitted/);
    assert.doesNotMatch(request.at(-1).content, /- \[P/);
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ maxRecallBytes: 0 }));
    await assert.rejects(extension.commands.get("pi-mem").handler("reload", ctx), /maxRecallBytes/);
    await next(/Project memory unavailable/);
    writeFileSync(join(directory, "pi-mem.json"), "{}");
    await extension.commands.get("pi-mem").handler("reload", ctx);
    await next(/Original project lesson[\s\S]*Replacement lesson[\s\S]*memory available/);

    // No append-only history exists across compaction, branch edits, or session replacement.
    await event("session_compact");
    raw = [user("Compacted summary", 100)];
    request = (await event("context", { messages: raw })).messages;
    assert.equal(request.length, 2);
    assert.match(request[0].content, /Replacement lesson/);
    assert.doesNotMatch(request[0].content, /New project lesson|Global lesson\.|MEMORY UPDATE/);
    add("After compaction.");
    const before = structuredClone(request);
    request = (await event("context", { messages: raw })).messages;
    assert.deepEqual(request.slice(0, before.length), before, "changes on an identical raw context append too");
    assert.match(request.at(-1).content, /After compaction/);
    const branch = (await event("context", { messages: [user("Different branch", 100)] })).messages;
    assert.equal(branch.length, 2);
    assert.match(branch[0].content, /After compaction/);
    await event("session_tree");
    assert.equal((await event("context", { messages: raw })).messages.length, 2);
    await event("session_start");
    assert.equal((await event("context", { messages: raw })).messages.length, 2);
    const empty = (await event("context", { messages: [] })).messages;
    assert.equal(empty.length, 1);
    assert.deepEqual((await event("context", { messages: [] })).messages, empty);
    assert.deepEqual(extension.sessionLog.getEntries(), [], "recall overlays must not persist or trigger turns");
  } finally {
    await event("session_shutdown");
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("memory menu browses privately, confirms retained writes, and cancels stale UI actions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-menu-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  const config = join(directory, "pi-mem.json");
  const settings = JSON.stringify({ maxLessonWords: 5, maxRecallLessons: 1, maxRecallBytes: 32768 });
  writeFileSync(config, settings);
  const project = join(directory, "project");
  mkdirSync(project);
  const notices: string[] = [];
  const messages: Array<{ content: string; customType?: string }> = [];
  const dispatchOptions: unknown[] = [];
  const widgets: Array<string[] | undefined> = [];
  const statuses: Array<string | undefined> = [];
  type Step = { title: string; choice?: string; text?: string; search?: string; beforeSearch?: RegExp; backspaces?: number; submit?: boolean; match?: RegExp; absent?: RegExp; before?: () => void | Promise<void> };
  const steps: Step[] = [];
  const inputs: string[] = [];
  let extension: Awaited<ReturnType<typeof load>>;
  let observer: MemoryStore | undefined;
  const dist = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const { KeybindingsManager } = await import(pathToFileURL(join(dist, "core/keybindings.js")).href);
  const keys = new KeybindingsManager({ "tui.select.confirm": "ctrl+y", "tui.select.cancel": "ctrl+x" });
  const ctx = {
    cwd: project, hasUI: true, mode: "tui",
    sessionManager: { getSessionId: () => "menu-session", getSessionFile: () => undefined,
      getEntries: (): SessionEntry[] => extension.sessionLog.getEntries(),
      getBranch: () => extension.sessionLog.getBranch(), getLeafId: () => extension.sessionLog.getLeafId() },
    modelRegistry: { complete: () => { throw new Error("Menu browsing must not call a model"); } },
    ui: {
      notify: (text: string) => notices.push(text), setStatus: (_key: string, text?: string) => statuses.push(text),
      setWidget: (_key: string, lines?: string[]) => widgets.push(lines),
      input: async () => { assert.ok(inputs.length, "unexpected input"); return inputs.shift(); },
      custom: async (factory: any) => {
        const step = steps.shift();
        assert.ok(step, "unexpected custom UI");
        let result: unknown;
        let finished = false;
        const tui = { terminal: { rows: 80 }, requestRender() {} };
        const component = await factory(tui, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, keys,
          (value: unknown) => { result = value; finished = true; });
        try {
          const screen = () => stripVTControlCharacters(component.render(220).join("\n"));
          assert.ok(screen().startsWith(step.title), `${step.title}: ${screen()}`);
          if (step.search !== undefined) {
            assert.match(screen(), /Type to search/);
            if (step.beforeSearch) assert.match(screen(), step.beforeSearch);
            component.focused = true;
            for (const char of step.search) component.handleInput(char);
            const projectSearch = step.title === "All projects" || step.title === "Move to project";
            const found = projectSearch ? /1 project/ : /1–1 of 1/;
            assert.match(screen(), found);
            component.handleInput("!");
            assert.match(screen(), projectSearch ? /No projects found/ : /No lessons found/);
            if (projectSearch) assert.match(screen(), /^→ Back$/m);
            component.handleInput("\x7f");
            assert.match(screen(), found);
          }
          for (let count = 0; count < (step.backspaces ?? 0); count++) component.handleInput("\x7f");
          if (step.title === "Archived lessons" || step.title.startsWith("Browse / search")) assert.doesNotMatch(screen(), /Clear search/);
          if (step.match) assert.match(screen(), step.match);
          if (step.absent) assert.doesNotMatch(screen(), step.absent);
          if (step.text !== undefined) {
            component.focused = true;
            component.handleInput("\x01"); // Start of prefilled lesson.
            component.handleInput("\x0b"); // Clear the line without changing the main Pi editor.
            component.handleInput(`\x1b[200~${step.text}\x1b[201~`);
            if (!step.title.startsWith("New cwd") && !step.title.startsWith("Backup folder")) assert.match(screen(), new RegExp(`${step.text.split(/\s+/u).length}/5 words`));
          }
          const full = screen();
          tui.terminal.rows = 12;
          for (const width of [1, 12, 40]) {
            assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width), full);
          }
          tui.terminal.rows = 80;
          component.invalidate();
          if (step.choice) {
            for (let count = 0; !screen().split("\n").some((line: string) => line.startsWith("→ ") && (/^\d+$/.test(step.choice!) ? line.slice(2).split(" —")[0].trim() === step.choice : line.includes(step.choice!))); count++) {
              assert.ok(count < 1020, `choice ${step.choice} not found: ${screen()}`);
              component.handleInput(["Not recalled only", "Show all active lessons", "Next page", "Previous page", "Back"].includes(step.choice!) ? "\x1b[A" : "\x1b[B");
            }
          }
          await step.before?.();
          if (!finished) component.handleInput(step.text !== undefined || step.submit ? "\r" : step.choice === undefined ? "\x18" : "\x19");
          assert.equal(finished, true, `UI did not close: ${step.title}`);
          return result;
        } finally { component.dispose?.(); }
      },
    },
  };
  const event = async (name: string, value: object = {}) => {
    for (const handler of extension?.handlers.get(name) ?? []) await handler(value, ctx);
  };
  try {
    extension = await load();
    extension.runtime.sendMessage = (message: { content: string }, options: unknown) => {
      messages.push(message);
      dispatchOptions.push(options);
    };
    await event("session_start");
    observer = new MemoryStore(process.env.PI_MEMORY_DB);
    for (let offset = 0; offset < 1002; offset += 500) {
      observer.addMany(project, Array.from({ length: Math.min(500, 1002 - offset) }, (_, i) => ({ text: `Seed ${offset + i}.`, evidence: "Verified.", basis: "user_request" as const })),
        { harness: "test", session: "seed-session" });
    }
    const original = observer.list(project, { query: "Seed 0." }).lessons[0];
    const command = extension.commands.get("pi-mem");
    const run = async () => {
      await command.handler("", ctx);
      assert.equal(steps.length, 0, `unreached menu steps; notices: ${notices.join("\n\n")}`);
      assert.equal(inputs.length, 0);
    };
    const backupDirectory = join(directory, "selected-backups");
    mkdirSync(backupDirectory);
    steps.push(
      { title: "Memory ·", choice: "Backups…" },
      { title: "Backups", choice: "Backup statistics", match: /Auto backup: off/ },
      { title: "Backup statistics", choice: "Back", match: /Total folder size: 0 B[\s\S]*Last successful backup: never/ },
      { title: "Backups", choice: "Auto backup…" },
      { title: "Auto backup", choice: "Daily" },
      { title: "Backups", choice: "Backup folder…", match: /Auto backup: daily/ },
      { title: "Backup folder — existing directory", text: backupDirectory },
      { title: "Change backup folder?", choice: "Use this folder", match: /Existing backups stay where they are/ },
      { title: "Backups", choice: "Back up now", match: /selected-backups/ },
      { title: "Backup created", choice: "Back", match: /Memory backup created:[\s\S]*1002 lessons \(1002 active, 0 archived\)[\s\S]*Backup folder total:/ },
      { title: "Backups", choice: "Backup statistics" },
      { title: "Backup statistics", choice: "Back", match: /Backup files in folder: 1[\s\S]*Last successful backup:/ },
      { title: "Backups", choice: "Back" },
      { title: "Memory ·" },
    );
    await run();
    const backups = new Backups(process.env.PI_MEMORY_DB);
    assert.deepEqual(backups.settings(), { frequency: "daily", folder: backupDirectory });
    assert.equal(backups.stats().files, 1);
    // Select an empty folder so startup is due without changing the clock.
    const startupDirectory = join(directory, "startup-backups");
    mkdirSync(startupDirectory);
    backups.configure({ folder: startupDirectory });
    await event("session_start", { reason: "startup" });
    assert.match(widgets.at(-1)!.join("\n"), /Memory backup created:[\s\S]*1002 lessons[\s\S]*Backup folder total:/);
    const startupWidget = widgets.at(-1);
    await event("session_shutdown", { reason: "reload" });
    await event("session_start", { reason: "reload" });
    assert.deepEqual(widgets.at(-1), startupWidget, "startup report survives reload");
    await event("input");
    assert.equal(widgets.at(-1), undefined);
    await event("session_start", { reason: "reload" });
    assert.equal(widgets.at(-1), undefined, "dismissed reports must not reappear on reload");
    assert.equal(backups.stats().files, 1);
    assert.equal(messages.length, 0, "backup reports must not steer the model");
    steps.push(
      { title: "Memory ·", choice: "Browse / search lessons", match: /1002 active · 1 loaded/ },
      { title: "Browse / search", choice: "Not recalled only", match: /lesson-count limit reached \(1 lesson\)/ },
      { title: "Browse / search", choice: "Next page", match: /Filter: Not recalled[\s\S]*1–1000 of 1001/ },
      { title: "Browse / search", choice: "Show all active lessons", match: /1001–1001 of 1001/ },
      { title: "Browse / search", choice: "Next page", match: /1–1000 of 1002/ },
      { title: "Browse / search", search: "Seed 0.", beforeSearch: /1001–1002 of 1002[\s\S]*\[omitted\]/, choice: "Not recalled only", match: /Search: Seed 0\.[\s\S]*\[omitted\]/ },
      { title: "Browse / search", choice: "Seed 0.", match: new RegExp(`Search: Seed 0\\.[\\s\\S]*Filter: Not recalled[\\s\\S]*#${original.id} · \\[P5\\] \\[omitted\\]`) },
      { title: "Lesson details", choice: "Replace…", match: /Evidence: Verified\.[\s\S]*Origin: test · session seed-session/ },
      { title: "Replace lesson", text: "Seed 0. Corrected.", match: /Project: .*project[\s\S]*2\/5 words/ },
      { title: "Review replacement", choice: "Cancel", match: /Project: .*project[\s\S]*BEFORE\nSeed 0\.\n\nAFTER\nSeed 0\. Corrected\./ },
      { title: "Lesson details", choice: "Replace…", before: () => { assert.equal(observer!.get(project, original.id).archived, false); } },
      { title: "Replace lesson", text: "Seed 0. Corrected." },
      { title: "Review replacement", choice: "Save" },
      { title: "Browse / search", choice: "Show all active lessons", match: /Search: Seed 0\.[\s\S]*Filter: Not recalled[\s\S]*No lessons found/ },
      { title: "Browse / search", choice: "Seed 0. Corrected.", match: /Search: Seed 0\./ },
      { title: "Lesson details", choice: "View predecessor", match: new RegExp(`Predecessor: #${original.id}`) },
      { title: "Lesson details", choice: "Back", match: /Archived records are read-only/ },
      { title: "Lesson details", choice: "Archive" },
      { title: "Archive lesson?", choice: "Cancel", match: /future recall[\s\S]*already in a conversation/ },
      { title: "Lesson details", choice: "Archive" },
      { title: "Archive lesson?", choice: "Archive" },
      { title: "Browse / search", choice: "Back", match: /No lessons found/ },
      { title: "Memory ·", choice: "Add lesson" },
      { title: "Add lesson", text: "These six words exceed the limit." },
      { title: "Add lesson", text: "New menu lesson." },
      { title: "Review new lesson", choice: "Priority…", match: /Priority: 5/ },
      { title: "Lesson priority", choice: "0 — Extreme" },
      { title: "Review new lesson", choice: "Save", match: /Priority: 0/ },
      { title: "Memory ·", choice: "Browse / search lessons" },
      { title: "Browse / search", choice: "New menu lesson.", match: /\[P0\]/ },
      { title: "Lesson details", choice: "Change priority…", match: /Priority: 0/ },
      { title: "Lesson priority", choice: "5" },
      { title: "Lesson details", choice: "History", match: /Priority: 5/ },
      { title: "History ·", choice: "Priority changed", match: /Retained changes only/ },
      { title: "Activity ·", choice: "Back", match: /Priority changed: 0 → 5[\s\S]*Actor: user[\s\S]*Session: menu-session/ },
      { title: "History ·", choice: "Back" },
      { title: "Lesson details", choice: "Back", match: /Priority: 5/ },
      { title: "Browse / search", choice: "Back" },
      { title: "Memory ·", choice: "Archived lessons" },
      { title: "Archived lessons", search: "Corrected", choice: "Seed 0. Corrected." },
      { title: "Lesson details", choice: "Back", match: /Archived records are read-only/ },
      { title: "Archived lessons", backspaces: 9, choice: "Back", match: /All lessons[\s\S]*1–2 of 2/ },
      { title: "Memory ·", choice: "Status & limits" },
      { title: "Status & limits", choice: "Back", match: /Project scope:[\s\S]*Archived: 2[\s\S]*5 words[\s\S]*1 lessons or 32 KiB/ },
      { title: "Memory ·" },
    );
    await run();
    assert.ok(notices.some((text) => /text exceeds 5 words/.test(text)));
    assert.equal(observer.get(project, original.id).archived, true);
    assert.equal(observer.list(project, { state: "archived" }).total, 2);
    assert.equal(observer.list(project, { query: "New menu lesson." }).lessons[0].basis, "user_request");
    assert.equal(messages.length, 0, "browsing and user writes must not inject model-context messages");
    const saveCards: CustomEntry[] = extension.sessionLog.getEntries().filter((entry: SessionEntry) => entry.type === "custom" && entry.customType === "pi-mem-saved");
    assert.equal(saveCards.length, 2, "only approved menu creations should add save entries");
    assert.equal(ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-mem-archived").length, 1,
      "only approved menu archives should add archive entries");
    assert.deepEqual(saveCards.map((entry) => (entry.data as Array<{ text: string }>)[0].text), ["Seed 0. Corrected.", "New menu lesson."]);

    // Cross-project actions target the selected scope without polluting this session's archive cards.
    const foreignScope = join(homedir(), `foreign-missing-project-${basename(directory)}`);
    assert.equal(existsSync(foreignScope), false); // Stored scope only: no directory is created outside the fixture.
    const foreign = observer.add(foreignScope, { text: "Foreign project lesson.", evidence: "Verified.", basis: "user_request" }, { harness: "test", session: null }).lesson;
    const archiveCardsBefore = ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-mem-archived").length;
    steps.push(
      { title: "Memory ·", choice: "All projects" },
      { title: "All projects", search: "~/foreign-missing-project-", choice: basename(foreignScope), match: /1 active \/ 0 archived/ },
      { title: "Project memories", choice: "Active lessons" },
      { title: "Browse / search", choice: foreign.text, match: /Other project/ },
      { title: "Lesson details", choice: "Change priority…", match: /other project \(not recalled here\)/ },
      { title: "Lesson priority", choice: "0 — Extreme", match: new RegExp(foreignScope) },
      { title: "Lesson details", choice: "Archive", match: /Priority: 0/ },
      { title: "Archive lesson?", choice: "Cancel" },
      { title: "Lesson details", choice: "Archive" },
      { title: "Archive lesson?", choice: "Archive" },
      { title: "Browse / search", choice: "Back", match: /No lessons found/ },
      { title: "Project memories", choice: "Archived lessons" },
      { title: "Archived lessons", choice: foreign.text },
      { title: "Lesson details", choice: "History", match: /archived \(not recalled\)/ },
      { title: "History ·", choice: "Back", match: /Lesson archived[\s\S]*Priority changed/ },
      { title: "Lesson details", choice: "Back" },
      { title: "Archived lessons", choice: "Back" },
      { title: "Project memories", choice: "Back" },
      { title: "All projects", choice: "Back" },
      { title: "Memory ·", match: /1002 active/ },
    );
    await run();
    assert.equal(observer.get(foreignScope, foreign.id).priority, 0);
    assert.equal(observer.get(foreignScope, foreign.id).archived, true);
    assert.equal(ctx.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "pi-mem-archived").length, archiveCardsBefore);

    // Move lists even missing/archived-only scopes, prefills cwd, and preserves retained IDs.
    const oldScope = join(directory, "missing-old-folder");
    const destination = join(directory, "moved-folder");
    mkdirSync(destination);
    const retained = observer.add(oldScope, { text: "Retained lesson.", evidence: "Verified.", basis: "user_request" }, { harness: "test", session: null }).lesson;
    observer.archive(oldScope, retained.id);
    for (const choice of ["Cancel", "Move memory"]) {
      steps.push({ title: "Memory ·", choice: "Move memory" },
        { title: "Move memory — select stored cwd", choice: oldScope },
        { title: "Move to project", choice: "Enter path…" },
        { title: "New cwd", match: new RegExp(project), text: destination },
        { title: "Move memory?", choice, match: /Move all 1 lessons/ },
        { title: "Memory ·" });
      await run();
      assert.equal(observer.get(choice === "Cancel" ? oldScope : destination, retained.id).archived, true);
    }
    assert.equal(observer.listScopes().includes(oldScope), false);

    // Menu counts and per-lesson labels must honor bytes, not just the configured lesson count.
    const oneLessonBytes = Buffer.byteLength(memoryContext({ lessons: observer.list(project, { limit: 1 }).lessons, total: 1002 }).text);
    writeFileSync(config, JSON.stringify({ maxLessonWords: 5, maxRecallLessons: 100, maxRecallBytes: oneLessonBytes }));
    await command.handler("reload", ctx);
    steps.push(
      { title: "Memory ·", choice: "Browse / search lessons", match: /1002 active · 1 loaded/ },
      { title: "Browse / search", choice: "Not recalled only", match: /byte budget reached[\s\S]*\[P5\] New menu lesson\.[\s\S]*\[omitted\] Seed/ },
      { title: "Browse / search", choice: observer.list(project, { limit: 2 }).lessons[1].text,
        match: /Filter: Not recalled[\s\S]*1–1000 of 1001/ },
      { title: "Lesson details", choice: "Back", match: /State: active · omitted by recall limits: byte budget reached/ },
      { title: "Browse / search", choice: "Back", match: /Filter: Not recalled/ },
      { title: "Memory ·" },
    );
    await run();
    writeFileSync(config, settings);
    await command.handler("reload", ctx);

    // Display normalization must not turn unchanged whitespace into literal escapes or new wording.
    const whitespace = "Keep\toriginal\r\nwhitespace.";
    observer.add(project, { text: whitespace, evidence: "Verified.", basis: "user_request" }, { harness: "test", session: null });
    steps.push({ title: "Memory ·", choice: "Browse / search lessons" },
      { title: "Browse / search", search: "Keep", choice: "Keep original whitespace." }, { title: "Lesson details", choice: "Replace…" },
      { title: "Replace lesson", submit: true, match: /3\/5 words/ }, { title: "Review replacement", choice: "Save" },
      { title: "Browse / search", choice: "Back" }, { title: "Memory ·" });
    await run();
    assert.equal(observer.list(project, { query: "Keep" }).lessons[0].text, whitespace);
    assert.equal(notices.some((text) => /characters are escaped/.test(text)), false, "ordinary whitespace must not raise control-character warnings");

    // Single-lesson moves include linked history, not unrelated lessons, and require menu approval.
    const moveOrigin = { harness: "test", session: null };
    const moveFirst = observer.add(project, { text: "Move this lesson.", evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    const moveLast = observer.supersede(project, moveFirst.id,
      { text: "Move corrected lesson.", evidence: "Verified.", basis: "user_request" }, moveOrigin);
    const sourceCount = observer.list(project, { state: "all" }).total;
    for (const choice of ["Cancel", "Move lesson"]) {
      steps.push({ title: "Memory ·", choice: "Archived lessons" },
        { title: "Archived lessons", search: "Move this", choice: "Move this lesson." },
        { title: "Lesson details", choice: "Move lesson to project…" },
        { title: "Move to project", choice: destination, match: /0 active \/ 1 archived/, absent: /foreign-missing-project/ },
        { title: "Move lesson?", choice, match: /entire linked replacement history, including any successor/ });
      if (choice === "Cancel") steps.push({ title: "Lesson details", choice: "Back" });
      steps.push({ title: "Archived lessons", choice: "Back" }, { title: "Memory ·" });
      await run();
      const expectedScope = choice === "Cancel" ? project : destination;
      assert.equal(observer.get(expectedScope, moveFirst.id).archived, true);
      assert.deepEqual(observer.get(expectedScope, moveLast.id), { ...moveLast, scope: expectedScope });
    }
    assert.equal(observer.list(project, { state: "all" }).total, sourceCount - 2);
    assert.equal(observer.get(destination, retained.id).archived, true, "occupied destination keeps unrelated history");
    const spacedDestination = join(directory, "single lesson destination");
    mkdirSync(spacedDestination);
    ctx.cwd = destination;
    await command.handler(`move #${moveLast.id} ${spacedDestination}`, ctx);
    assert.deepEqual(observer.get(spacedDestination, moveLast.id), { ...moveLast, scope: spacedDestination });
    assert.equal(observer.get(spacedDestination, moveFirst.id).archived, true);
    assert.equal(observer.get(destination, retained.id).archived, true);
    await command.handler(`move ${retained.id}`, ctx);
    assert.match(notices.at(-1)!, /Usage: \/pi-mem move/);
    ctx.cwd = project;

    // Scope moves preserve the whole chain, reject duplicates, and require menu approval.
    ctx.cwd = spacedDestination;
    for (const choice of ["Cancel", "Move lesson"]) {
      steps.push({ title: "Memory ·", choice: "Archived lessons" },
        { title: "Archived lessons", choice: moveFirst.text },
        { title: "Lesson details", choice: "Move lesson to global…" },
        { title: "Move lesson?", choice, match: /Global lessons are recalled in every project/ });
      if (choice === "Cancel") steps.push({ title: "Lesson details", choice: "Back" });
      steps.push({ title: "Archived lessons", choice: "Back" }, { title: "Memory ·" });
      await run();
      const expectedScope = choice === "Cancel" ? spacedDestination : GLOBAL_SCOPE;
      assert.deepEqual(observer.get(expectedScope, moveLast.id), { ...moveLast, scope: expectedScope });
      assert.equal(observer.get(expectedScope, moveFirst.id).archived, true);
    }
    steps.push({ title: "Memory ·", choice: "Global lessons" },
      { title: "Global lessons", choice: "Active lessons" },
      { title: "Browse / search", choice: moveLast.text },
      { title: "Lesson details", choice: "Move lesson to project…" },
      { title: "Move to project", search: "single lesson destination", choice: "Enter path…" },
      { title: "New cwd" },
      { title: "Move to project", choice: "Enter path…", match: /Search: single lesson destination/ },
      { title: "New cwd", text: spacedDestination },
      { title: "Move lesson?", choice: "Move lesson" },
      { title: "Browse / search", choice: "Back", match: /No lessons found/ },
      { title: "Global lessons", choice: "Back" }, { title: "Memory ·" });
    await run();
    const duplicate = observer.add(GLOBAL_SCOPE,
      { text: moveLast.text, evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    const historyBefore = observer.history(spacedDestination, moveLast.id);
    await command.handler(`move ${moveFirst.id} --global`, ctx);
    assert.match(notices.at(-1)!, /Duplicate active text/);
    assert.deepEqual(observer.history(spacedDestination, moveLast.id), historyBefore);
    assert.equal(observer.get(spacedDestination, moveFirst.id).archived, true);
    observer.archive(GLOBAL_SCOPE, duplicate.id);
    await command.handler(`move ${moveFirst.id} --global`, ctx);
    assert.deepEqual(observer.get(GLOBAL_SCOPE, moveLast.id), { ...moveLast, scope: GLOBAL_SCOPE });
    await command.handler(`move ${moveLast.id} --project`, ctx);
    assert.deepEqual(observer.get(spacedDestination, moveLast.id), { ...moveLast, scope: spacedDestination });
    assert.equal(observer.get(spacedDestination, moveFirst.id).archived, true);
    assert.deepEqual(observer.history(spacedDestination, moveLast.id).events[0].details,
      { before: GLOBAL_SCOPE, after: spacedDestination });
    ctx.cwd = project;

    steps.push({ title: "Memory ·", choice: "Global lessons" },
      { title: "Global lessons", choice: "Add lesson" },
      { title: "Add lesson", text: "Check CLI dry runs.", match: /Add lesson\nGlobal/ },
      { title: "Review new lesson", choice: "Save", match: /Review new lesson\nGlobal[\s\S]*global lesson for recall in every project/ },
      { title: "Global lessons", choice: "Active lessons" },
      { title: "Browse / search", choice: "Check CLI dry runs.", match: /Global/ },
      { title: "Lesson details", choice: "Archive", match: /Global[\s\S]*active · loaded into recall/ },
      { title: "Archive lesson?", choice: "Archive" },
      { title: "Browse / search", choice: "Back" },
      { title: "Global lessons", choice: "Back" }, { title: "Memory ·" });
    await run();
    assert.equal(observer.list(GLOBAL_SCOPE, { state: "archived" }).total, 2);
    assert.equal(observer.list(GLOBAL_SCOPE).total, 0);

    // Audit bypasses recall/output limits but requires an explicit destination and approval.
    const globalAudit = observer.add(GLOBAL_SCOPE, { text: "Global audit lesson.", evidence: "Verified.", basis: "user_request", priority: 0 }, moveOrigin).lesson;
    const foreignAudit = observer.add(foreignScope, { text: "Foreign audit lesson.", evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    const historyBeforeAudit = observer.history(project, original.id);
    const currentAudit = buildAudit(observer, project);
    const allAudit = buildAudit(observer, project, true);
    assert.ok(allAudit.length > currentAudit.length);
    const currentAuditSnapshot = observer.auditSnapshot(project);
    const estimateId = "00000000-0000-0000-0000-000000000000";
    const currentTokens = formatTokens(Math.ceil(stagedAudit(currentAuditSnapshot, estimateId).length / 4));
    const allTokens = formatTokens(Math.ceil(stagedAudit(observer.auditSnapshot(project, true), estimateId).length / 4));
    steps.push({ title: "Memory ·", choice: "Audit…" },
      { title: "Audit memories — scope", choice: `Current project + global (~${currentTokens} tokens)`, match: /full audit text and metadata/ },
      { title: "Audit memories — output", choice: "Send to agent" },
      { title: "Send audit to agent?", choice: "Cancel", match: /selected model[\s\S]*Priority 0/ },
      { title: "Memory ·" });
    await run();
    assert.equal(messages.length, 0);
    const file = join(directory, "menu audit.md");
    inputs.push(file);
    steps.push({ title: "Memory ·", choice: "Audit…" },
      { title: "Audit memories — scope", choice: `All projects + global (~${allTokens} tokens)` },
      { title: "Audit memories — output", choice: "Export to file" },
      { title: "Export audit?", choice: "Export", match: /missing project folders[\s\S]*No agent turn/ },
      { title: "Memory ·" });
    await run();
    assert.equal(readFileSync(file, "utf8"), allAudit);
    assert.match(readFileSync(file, "utf8"), /Foreign audit lesson/);
    assert.equal(messages.length, 0, "file audit must not dispatch a model message");
    steps.push({ title: "Memory ·", choice: "Audit…" },
      { title: "Audit memories — scope", choice: "Current project + global" },
      { title: "Audit memories — output", choice: "Send to agent" },
      { title: "Send audit to agent?", choice: "Send to agent" });
    await run(); // Sending exits the menu instead of reopening it over an agent turn.
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "pi-mem-audit");
    const sentAuditId = JSON.parse(/with auditId ("[^"]+")/.exec(messages[0].content)![1]);
    assert.equal(messages[0].content, stagedAudit(currentAuditSnapshot, sentAuditId));
    assert.equal(formatTokens(Math.ceil(messages[0].content.length / 4)), currentTokens);
    assert.match(messages[0].content, /Seed 1\.[\s\S]*Seed 1000\.|Seed 1000\.[\s\S]*Seed 1\./);
    assert.match(messages[0].content, /Global audit lesson/);
    assert.doesNotMatch(messages[0].content, /Foreign audit lesson|Seed 0\. Corrected\./);
    assert.ok(Buffer.byteLength(messages[0].content) > 16384);
    assert.deepEqual(dispatchOptions[0], { triggerTurn: true, deliverAs: "followUp" });
    await command.handler("audit --all-projects", ctx);
    assert.match(messages.at(-1)!.content, /Foreign audit lesson/);
    const directFile = join(project, "direct audit.md");
    await command.handler("audit --file direct audit.md", ctx);
    assert.equal(readFileSync(directFile, "utf8"), buildAudit(observer, project));
    assert.doesNotMatch(readFileSync(directFile, "utf8"), /Submit the complete proposal/);
    await command.handler("audit --file direct audit.md", ctx);
    assert.match(notices.at(-1)!, /EEXIST/);
    await command.handler("audit --file", ctx);
    assert.match(notices.at(-1)!, /Usage:/);
    assert.deepEqual(observer.history(project, original.id), historyBeforeAudit);
    assert.equal(observer.get(GLOBAL_SCOPE, globalAudit.id).priority, 0);
    assert.equal(observer.get(foreignScope, foreignAudit.id).archived, false);

    // Structured proposals, never Markdown parsing or unrestricted agent writes: all scopes share one approval.
    const proposal = extension.tools.get("memory_audit").definition;
    const proposalId = () => JSON.parse(/with auditId ("[^"]+")/.exec(messages.at(-1)!.content)![1]);
    const submit = (changes: object[], auditId = proposalId(), signal?: AbortSignal) =>
      proposal.execute("proposal", proposal.prepareArguments({ auditId, changes }), signal, undefined, ctx);
    for (const id of [true, {}, 1.5]) assert.throws(() => proposal.prepareArguments({ auditId: "test",
      changes: [{ id, action: "archive", reason: "Redundant" }] }), /id must/);
    assert.throws(() => proposal.prepareArguments({ auditId: "test", changes: [
      { id: foreignAudit.id, action: "set_priority", priority: true, reason: "Useful" }] }), /priority must/);
    await assert.rejects(submit([{ id: globalAudit.id, action: "archive", reason: "Extreme" }]), /user-reserved/);
    const outside = observer.add(foreignScope, { text: "Created after audit.", evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    await assert.rejects(submit([{ id: outside.id, action: "archive", reason: "New" }]), /not in this audit/);
    const ordinaryTool = extension.tools.get("memory").definition;
    await assert.rejects(ordinaryTool.execute("call", { action: "archive", id: globalAudit.id }, undefined, undefined, ctx), /review pending/);
    const oldToken = proposalId();
    steps.push({ title: "Review memory audit", choice: "Cancel", match: /1 changes[\s\S]*Foreign audit lesson[\s\S]*Reason: Low value/ });
    assert.equal((await submit([{ id: foreignAudit.id, action: "archive", reason: "Low value" }])).details.status, "cancelled");
    assert.equal(observer.get(foreignScope, foreignAudit.id).archived, false);
    await assert.rejects(ordinaryTool.execute("call", { action: "archive", id: globalAudit.id }, undefined, undefined, ctx), /review pending/);
    await assert.rejects(submit([], oldToken), /No matching pending audit/);
    await command.handler("audit", ctx);
    await assert.rejects(submit([{ id: foreignAudit.id, action: "archive", reason: "Other project" }]), /not in this audit/);
    await command.handler("audit --all-projects", ctx);
    const currentArchive = observer.add(project, { text: "Audit archive.", evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    const globalRank = observer.add(GLOBAL_SCOPE, { text: "Audit ranking.", evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    await command.handler("audit --all-projects", ctx);
    steps.push({ title: "Review memory audit", choice: "Apply all", match: /3 changes: 1 archives · 1 priority changes · 1 moves to global[\s\S]*cannot be restored[\s\S]*Priority 5 → 3/ });
    const archivesBeforeAudit = Number(/-(\d+)/.exec(statuses.at(-1) ?? "")?.[1] ?? 0);
    const applied = await submit([{ id: currentArchive.id, action: "archive", reason: "Low value" },
      { id: globalRank.id, action: "set_priority", priority: 3, reason: "Recurring failures" },
      { id: foreignAudit.id, action: "move_global", reason: "Cross-project guidance" }]);
    assert.equal(applied.details.status, "applied");
    assert.equal(applied.details.count, 3);
    assert.equal(observer.get(project, currentArchive.id).archived, true);
    assert.equal(observer.history(project, currentArchive.id).events[0].action, "archive");
    const auditEntry = extension.sessionLog.getEntries().find((entry: SessionEntry): entry is CustomEntry =>
      entry.type === "custom" && entry.customType === "pi-mem-archived" && (entry.data as { id?: number } | undefined)?.id === currentArchive.id);
    assert.ok(auditEntry, "audit archives retain a durable footer marker");
    assert.equal(auditEntry.data.audit, true);
    const archiveRenderer = extension.entryRenderers.get("pi-mem-archived")!;
    const theme = { fg: (_color: string, text: string) => text } as any;
    for (const expanded of [false, true]) assert.equal(archiveRenderer(auditEntry, { expanded }, theme), undefined);
    const archiveCount = new RegExp(`-${archivesBeforeAudit + 1}\\)`);
    assert.match(statuses.at(-1)!, archiveCount);
    await command.handler("reload", ctx);
    assert.match(statuses.at(-1)!, archiveCount);
    await event("session_start");
    assert.match(statuses.at(-1)!, archiveCount);
    assert.equal(archiveRenderer(auditEntry, { expanded: false }, theme), undefined);
    assert.equal(observer.get(GLOBAL_SCOPE, globalRank.id).priority, 3);
    assert.equal(observer.get(GLOBAL_SCOPE, foreignAudit.id).scope, GLOBAL_SCOPE);
    assert.equal(observer.history(GLOBAL_SCOPE, foreignAudit.id).events[0].actor, "user");
    const untouched = observer.add(project, { text: "Keep unchanged.", evidence: "Verified.", basis: "user_request" }, moveOrigin).lesson;
    await command.handler("audit", ctx);
    steps.push({ title: "Review memory audit", choice: "Apply all", before: () => { observer!.setPriority(project, untouched.id, 4, moveOrigin); } });
    await assert.rejects(submit([{ id: untouched.id, action: "archive", reason: "Stale" }]), /stale/i);
    assert.equal(observer.get(project, untouched.id).archived, false);
    await command.handler("audit", ctx);
    steps.push({ title: "Review memory audit", choice: "Apply all", before: async () => { await event("session_tree"); } });
    await assert.rejects(submit([{ id: untouched.id, action: "archive", reason: "Navigated" }]), /branch changed/);
    assert.equal(observer.get(project, untouched.id).archived, false);
    const blockedWrite = () => ordinaryTool.execute("call", { action: "archive", id: globalAudit.id }, undefined, undefined, ctx);
    await assert.rejects(blockedWrite(), /review pending/);
    await command.handler("audit", ctx);
    steps.push({ title: "Review memory audit", choice: "Apply all", before: async () => { await command.handler("reload", ctx); } });
    await assert.rejects(submit([{ id: untouched.id, action: "archive", reason: "Reloaded" }]), /Session or memory configuration changed/);
    await assert.rejects(blockedWrite(), /review pending/);
    await command.handler("audit", ctx);
    steps.push({ title: "Review memory audit", choice: "Apply all", before: async () => { await event("session_compact"); } });
    await assert.rejects(submit([{ id: untouched.id, action: "archive", reason: "Compacted" }]), /branch changed/);
    await assert.rejects(blockedWrite(), /review pending/);
    assert.equal(observer.get(project, untouched.id).archived, false);
    assert.equal(observer.get(GLOBAL_SCOPE, globalAudit.id).archived, false);
    await command.handler("audit", ctx);
    const abortProposal = new AbortController();
    steps.push({ title: "Review memory audit", choice: "Apply all", before: () => { abortProposal.abort(new Error("proposal cancelled")); } });
    await assert.rejects(submit([{ id: untouched.id, action: "archive", reason: "Cancelled" }], proposalId(), abortProposal.signal), /proposal cancelled/);
    await command.handler("audit", ctx);
    ctx.hasUI = false;
    await assert.rejects(submit([]), /requires interactive or RPC UI/);
    ctx.hasUI = true;
    assert.equal((await submit([])).details.status, "no changes");
    await command.handler("audit", ctx);
    const cancelledToken = proposalId();
    await command.handler("audit cancel", ctx);
    await assert.rejects(submit([], cancelledToken), /No matching pending audit/);
    await assert.rejects(blockedWrite(), /review pending/);
    await event("before_agent_start"); // A fresh user prompt, not an automatic continuation, releases the barrier.
    assert.equal(JSON.parse((await ordinaryTool.execute("call", { action: "set_priority", id: globalRank.id, priority: 3,
      basis: "user_request" }, undefined, undefined, ctx)).content[0].text).status, "priority updated");
    assert.equal(steps.length, 0);

    // Reconnect invalidates a pending confirmation, even if it eventually returns approval.
    const total = observer.list(project).total;
    steps.push({ title: "Memory ·", choice: "Add lesson" }, { title: "Add lesson", text: "Must not save." },
      { title: "Review new lesson", choice: "Save", before: async () => { await event("session_shutdown"); await event("session_start"); } });
    await run();
    assert.equal(observer.list(project).total, total);

    // Initialization failures retain status/help/reload navigation and can recover in the same menu.
    delete process.env.PI_MEMORY_DB;
    writeFileSync(config, "invalid JSON");
    await event("session_shutdown"); await event("session_start");
    steps.push({ title: "Memory ·", choice: "Status & limits", match: /Memory unavailable/ },
      { title: "Status & limits", choice: "Back", match: /Reload memory retries initialization/ },
      { title: "Memory ·", choice: "Reload memory", before: () => { writeFileSync(config, settings); } },
      { title: "Memory ·", match: /0 active · 0 loaded/ });
    await run();
    const beforeReport = messages.length;
    ctx.hasUI = false; ctx.mode = "print";
    await command.handler("", ctx);
    assert.equal(messages.length, beforeReport + 1);
    assert.match(messages.at(-1)!.content, /^Database: .+\nPROJECT LESSONS$/);
  } finally {
    await event("session_shutdown");
    observer?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
