import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  return result.extensions[0];
}

test("real Pi loader: immediate persistence, bounded replaceable recall, lifecycle, commands and failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-mem-load-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = directory;
  process.env.PI_MEMORY_DB = join(directory, "db.sqlite3");
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    cwd: join(directory, "project"), hasUI: true,
    sessionManager: { getSessionId: () => "load-session", getSessionFile: (): string | undefined => "/temporary/session.jsonl" },
    ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, text?: string) => statuses.push(text) },
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
    writeFileSync(join(directory, "pi-mem.json"), JSON.stringify({ databasePath: "db.sqlite3" }));
    await command.handler("reload", ctx);
    assert.match(notices.at(-1)!, /Saved by a command/);
  } finally {
    await event("session_shutdown", { reason: "quit" });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
