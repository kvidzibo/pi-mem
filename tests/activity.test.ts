import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryStore, type Origin } from "../src/store.ts";

test("activity follows every mutation atomically, remains immutable, and migrates only known attribution", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-activity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "memory.sqlite3");
  let store = new MemoryStore(path);
  const raw = new DatabaseSync(path);
  t.after(() => { raw.close(); store.close(); });
  const scope = "/activity-test";
  const user: Origin = { harness: "pi", session: "human-session", actor: "user" };
  const model: Origin = { harness: "pi", session: "model-session", actor: "model", provider: "provider", model: "model-id", reason: "Verified correction." };
  const input = { text: "Keep this lesson.", evidence: "Verified.", basis: "validated_fix" as const, priority: 4 };
  const first = store.add(scope, input, model).lesson;
  const creation = store.history(scope, first.id).events[0];
  assert.equal(creation.action, "create");
  assert.equal(creation.model, "model-id");
  assert.equal(creation.provider, "provider");
  assert.equal(creation.reason, "Verified correction.");
  store.add(scope, input, model);
  store.setPriority(scope, first.id, 4, model);
  assert.equal(store.history(scope, first.id).events.length, 1, "no-op writes are not changes");
  store.setPriority(scope, first.id, 2, model);
  assert.deepEqual(store.history(scope, first.id).events[0].details, { before: 4, after: 2 });
  store.setPriority(scope, first.id, 0, user);
  assert.throws(() => store.setPriority(scope, first.id, 3, model), /user-reserved/);
  assert.throws(() => store.setPriority(scope, first.id, 0, model), /priority/);
  const second = store.supersede(scope, first.id, { ...input, text: "Keep the corrected lesson.", priority: 9 }, model);
  assert.equal(second.priority, 0);
  assert.equal(store.history(scope, first.id).events[0].details.successor_id, second.id);
  assert.equal(store.history(scope, second.id).events[0].details.predecessor_id, first.id);
  assert.equal(store.moveLesson(scope, first.id, "/moved", user), 2);
  assert.throws(() => store.history(scope, first.id), /not found/);
  for (const id of [first.id, second.id]) {
    const movement = store.history("/moved", id).events.find((event) => event.action === "move")!;
    assert.deepEqual(movement.details, { before: scope, after: "/moved" });
    assert.equal(movement.actor, "user");
  }
  store.moveScope("/moved", scope, user);
  store.archive(scope, second.id, model);
  const archives = store.history(scope, second.id).events.filter((event) => event.action === "archive");
  assert.equal(archives.length, 1);
  assert.equal(archives[0].actor, "model");
  store.archive(scope, second.id, model);
  assert.equal(store.history(scope, second.id).events.filter((event) => event.action === "archive").length, 1);
  assert.throws(() => store.setPriority(scope, second.id, 4, user), /read-only/);
  const imported = store.addMany(scope, [{ ...input, text: "Imported lesson.", basis: "import" }], user)[0].lesson;
  assert.equal(store.history(scope, imported.id).events[0].action, "import");
  assert.equal(store.history(scope, first.id, 0, 1).nextOffset, 1);
  assert.throws(() => store.history(scope, first.id, -1), /offset/);
  for (const sql of ["UPDATE activity SET actor = 'user'", "DELETE FROM activity", "INSERT OR REPLACE INTO activity SELECT * FROM activity"]) {
    assert.throws(() => raw.exec(sql), /Activity/);
  }
  raw.exec("CREATE TRIGGER reject_activity BEFORE INSERT ON activity BEGIN SELECT RAISE(ABORT, 'audit failure'); END");
  const snapshot = () => JSON.stringify({ lessons: raw.prepare("SELECT * FROM lessons ORDER BY id").all(),
    activity: raw.prepare("SELECT * FROM activity ORDER BY id").all(), priority: raw.prepare("SELECT * FROM priority_changes ORDER BY id").all() });
  const before = snapshot();
  for (const mutate of [
    () => store.add(scope, { ...input, text: "New lesson." }, model),
    () => store.addMany(scope, [{ ...input, text: "New batch lesson." }], user),
    () => store.supersede(scope, imported.id, { ...input, text: "New replacement." }, model),
    () => store.setPriority(scope, imported.id, 7, model),
    () => store.archive(scope, imported.id, model),
    () => store.moveLesson(scope, imported.id, "/elsewhere", user),
    () => store.moveScope(scope, "/elsewhere", user),
  ]) {
    assert.throws(mutate, /audit failure/);
    assert.equal(snapshot(), before, "mutation and audit must roll back together");
  }
  raw.exec("DROP TRIGGER reject_activity; CREATE TRIGGER reject_move BEFORE UPDATE OF scope ON lessons BEGIN SELECT RAISE(ABORT, 'move failure'); END");
  assert.throws(() => store.moveScope(scope, "/elsewhere", user), /move failure/);
  assert.equal(snapshot(), before, "failed moves must also roll back already-written activity");
  assert.throws(() => raw.exec("UPDATE lessons SET text = 'changed'"), /immutable/);
  raw.exec("DROP TRIGGER reject_move");
  store.close();
  // Reconstruct a v6 fixture by removing only the newly introduced table.
  raw.exec("DROP TABLE activity; PRAGMA user_version = 6");
  store = new MemoryStore(path);
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 8);
  const recovered = store.history(scope, first.id).events;
  assert.ok(recovered.every((event) => event.historical && event.actor === "unknown" && event.model === null));
  assert.equal(recovered.filter((event) => event.action === "set_priority").length, 2);
  assert.equal(recovered.find((event) => event.action === "create")!.details.scope, undefined, "moves make creation scope unknowable");
  assert.equal(recovered.find((event) => event.action === "supersede")!.details.successor_id, second.id);
  assert.equal(recovered.some((event) => event.action === "move"), false, "unrecorded old moves must not be invented");
  store.close();
  store = new MemoryStore(path);
  assert.deepEqual(store.history(scope, first.id).events, recovered, "reopening must not duplicate backfill");
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(raw.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
});
