import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { runMemory } from "../src/operations.ts";
import { memoryContext } from "../src/presentation.ts";
import { MemoryStore } from "../src/store.ts";

test("priority ranks recall, preserves history and reserves extreme priority for humans", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-priority-"));
  const path = join(dir, "memory.sqlite3");
  const store = new MemoryStore(path, { ...DEFAULT_LIMITS, maxRecallLessons: 2 });
  const raw = new DatabaseSync(path);
  t.after(() => { raw.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const scope = "/project";
  const origin = { harness: "test", session: "priority-session" };
  const input = { text: "Preserve database integrity.", evidence: "Verified.", basis: "user_request" as const };
  for (const priority of [undefined, null, true, "1", -1, 0, 1.5, 11]) {
    assert.throws(() => runMemory(store, scope, { action: "add", ...input, priority: priority as number }, origin), /priority must/);
  }
  const high = runMemory(store, scope, { action: "add", ...input, priority: 2 }, origin);
  const low = runMemory(store, scope, { action: "add", ...input, text: "A narrow test quirk.", priority: 8 }, origin);
  const human = store.add(scope, { ...input, text: "User extreme lesson.", priority: 0 }, origin).lesson;
  const before = store.get(scope, low.id);
  assert.deepEqual(memoryContext(store.recall(scope)).loadedIds, [human.id, high.id]);
  const recalled = memoryContext(store.recall(scope));
  assert.match(recalled.text, /\[P0\] User extreme lesson/);
  assert.match(recalled.text, /\[1 lessons omitted\.\]/);
  const byteBounded = memoryContext(store.recall(scope), Buffer.byteLength(recalled.text) - 1);
  assert.deepEqual(byteBounded.loadedIds, [human.id]);
  assert.ok(Buffer.byteLength(byteBounded.text) <= Buffer.byteLength(recalled.text) - 1);

  const changed = store.setPriority(scope, low.id, 1, origin);
  assert.deepEqual(changed, { ...before, priority: 1 });
  assert.deepEqual(memoryContext(store.recall(scope)).loadedIds, [human.id, low.id]);
  store.setPriority(scope, low.id, 1, origin);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM priority_changes").get()!.n, 1);
  assert.deepEqual({ ...raw.prepare("SELECT lesson_id, old_priority, new_priority, source_session FROM priority_changes").get() },
    { lesson_id: low.id, old_priority: 8, new_priority: 1, source_session: origin.session });
  for (const sql of ["DELETE FROM priority_changes", "UPDATE priority_changes SET new_priority = 10", "INSERT OR REPLACE INTO priority_changes SELECT * FROM priority_changes"]) {
    assert.throws(() => raw.exec(sql), /Priority history/);
  }
  assert.throws(() => store.setPriority("/other", low.id, 0, origin), /not found/);
  assert.throws(() => store.setPriority(scope, low.id, true as unknown as number, origin), /priority must/);
  const duplicate = runMemory(store, scope, { action: "add", ...input, priority: 10 }, origin);
  assert.equal(duplicate.priority, 2, "duplicate adds must not reprioritize");
  const successor = runMemory(store, scope, { action: "supersede", id: low.id, ...input, text: "Corrected narrow quirk." }, origin);
  assert.equal(successor.priority, 1, "replacement inherits priority");
  assert.throws(() => store.setPriority(scope, low.id, 0, origin), /read-only/);
  for (const priority of [0, -1, 11, true, null]) {
    assert.throws(() => runMemory(store, scope, { action: "supersede", id: human.id, ...input, priority: priority as number }, origin), /priority must/);
  }
  const extreme = runMemory(store, scope, { action: "supersede", id: human.id, ...input,
    text: "Corrected extreme lesson.", priority: 10 }, origin);
  assert.equal(extreme.priority, 0, "agent replacement cannot demote a user extreme lesson");
  assert.equal(store.setPriority(scope, extreme.id, 10, origin).priority, 10, "user can demote extreme metadata explicitly");
  raw.exec(`CREATE TRIGGER fail_priority BEFORE UPDATE OF priority ON lessons BEGIN SELECT RAISE(ABORT, 'forced'); END;`);
  const count = raw.prepare("SELECT count(*) AS n FROM priority_changes").get()!.n;
  assert.throws(() => store.setPriority(scope, high.id, 1, origin), /forced/);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM priority_changes").get()!.n, count, "audit and update are atomic");
  assert.equal(store.get(scope, high.id).priority, 2);
});
