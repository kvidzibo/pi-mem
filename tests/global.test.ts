import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GLOBAL_SCOPE, MemoryStore } from "../src/store.ts";

test("global lessons follow sessions across projects without exposing other project IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-global-"));
  const previous = { PI_MEMORY_DB: process.env.PI_MEMORY_DB, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_MEMORY_DB = join(dir, "memory.sqlite3");
  writeFileSync(join(dir, "pi-mem.json"), JSON.stringify({ maxRecallLessons: 1, maxRecallBytes: 8192 }));
  const project = join(dir, "project");
  const other = join(dir, "other");
  mkdirSync(project); mkdirSync(other);
  const root = resolve(import.meta.dirname, "..");
  const loader = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/extensions/loader.js");
  const { loadExtensions } = await import(pathToFileURL(loader).href);
  const loaded = await loadExtensions([join(root, "index.ts")], root);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const cards: unknown[] = [];
  loaded.runtime.appendEntry = (_type: string, data: unknown) => cards.push(data);
  const ctx = { cwd: project, hasUI: false, mode: "print",
    sessionManager: { getSessionId: () => "global-test", getSessionFile: () => "/temporary/session.jsonl", getBranch: () => [] } };
  const event = async (name: string, value: object = {}) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(value, ctx);
    return result;
  };
  const tool = extension.tools.get("memory").definition;
  const execute = async (params: object) => (await tool.execute("call", tool.prepareArguments(params), undefined, undefined, ctx)).details;
  const input = { action: "add", text: "Use CLI dry runs before writes.", evidence: "Verified CLI behavior.", basis: "validated_learning", priority: 3 };
  let store: MemoryStore | undefined;
  try {
    const local = await execute(input);
    const global = await execute({ ...input, scope: "global" });
    assert.notEqual(global.id, local.id, "duplicates are scope-local");
    assert.equal(global.scope, GLOBAL_SCOPE);
    assert.equal((await execute({ ...input, scope: "global" })).id, global.id);
    store = new MemoryStore(process.env.PI_MEMORY_DB);
    const hidden = store.add(other, { text: "Other project secret.", evidence: "Verified.", basis: "user_request" }, { harness: "test", session: null }).lesson;
    await assert.rejects(execute({ action: "archive", id: hidden.id }), /not found/);
    await assert.rejects(execute({ ...input, scope: "/arbitrary" }), /scope must/);
    await assert.rejects(execute({ action: "archive", id: global.id, scope: "project" }), /only supported for add/);
    let recall = (await event("context", { messages: [] })).messages[0].content;
    assert.match(recall, /^GLOBAL LESSONS/);
    assert.match(recall, new RegExp(`#${global.id}\\n\\nPROJECT LESSONS`));
    assert.match(recall, new RegExp(`#${local.id}$`));
    const extra = await execute({ ...input, scope: "global", text: "A lower priority global lesson.", priority: 9 });
    recall = (await event("context", { messages: [] })).messages[0].content;
    assert.match(recall, /1 lessons omitted/);
    assert.doesNotMatch(recall, new RegExp(`#${extra.id}(?:\\n|$)`));
    assert.match(recall, new RegExp(`#${local.id}$`), "global budget cannot crowd out project recall");
    ctx.cwd = other;
    recall = (await event("context", { messages: [] })).messages[0].content;
    assert.match(recall, new RegExp(`#${global.id}\\n`));
    assert.doesNotMatch(recall, new RegExp(`#${local.id}(?:\\n|$)`));
    await assert.rejects(execute({ action: "archive", id: local.id }), /not found/);
    await execute({ action: "set_priority", id: global.id, priority: 2 });
    const replacement = await execute({ ...input, action: "supersede", id: global.id, text: "Check CLI dry-run output before writes." });
    assert.equal(replacement.scope, GLOBAL_SCOPE);
    assert.equal(store.get(GLOBAL_SCOPE, global.id).archived, true);
    assert.equal(store.get(GLOBAL_SCOPE, replacement.id).supersedes_id, global.id);
    assert.equal(store.history(GLOBAL_SCOPE, global.id).events.some((entry) => entry.action === "set_priority"), true);
    await execute({ action: "archive", id: replacement.id });
    assert.equal(store.get(GLOBAL_SCOPE, replacement.id).archived, true);
    assert.equal(cards.length, 5, "global saves, replacements and archives produce chat cards");
    await event("session_shutdown");
    await event("session_start");
    recall = (await event("context", { messages: [] })).messages[0].content;
    assert.match(recall, new RegExp(`#${extra.id}\\n\\nPROJECT LESSONS`));
    assert.doesNotMatch(recall, /Check CLI dry-run/);
  } finally {
    await event("session_shutdown");
    store?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
