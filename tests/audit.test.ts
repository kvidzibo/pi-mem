import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAudit, writeAudit } from "../src/audit.ts";
import { GLOBAL_SCOPE, MemoryStore } from "../src/store.ts";

test("audit exports every active lesson across requested scopes and writes exclusively with private mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-audit-"));
  const store = new MemoryStore(join(dir, "db.sqlite"));
  try {
    const project = join(dir, "project");
    const other = join(dir, "other");
    for (let i = 0; i < 1002; i++) store.add(project, { text: `Lesson ${i} ${"detail ".repeat(8)}`, evidence: `Evidence ${i}`, basis: "validated_learning" }, { harness: "test", session: null });
    store.add(other, { text: "Other project", evidence: "Evidence", basis: "user_request" }, { harness: "test", session: null });
    const old = store.add(project, { text: "Archived", evidence: "Evidence", basis: "user_request" }, { harness: "test", session: null }).lesson;
    store.archive(project, old.id);
    const simple = buildAudit(store, project);
    assert.ok(simple.length > 16 * 1024);
    assert.match(simple, /Lesson 1001/);
    const data = JSON.parse(simple.split("```json\n")[1].split("\n```")[0]);
    assert.equal(data[project].length, 1002);
    assert.ok(data[project].some((lesson: { evidence: string }) => lesson.evidence === "Evidence 1001"));
    assert.equal(data[project][0].source_harness, "test");
    assert.doesNotMatch(simple, /Other project/);
    assert.doesNotMatch(simple, /Archived/);
    const complete = buildAudit(store, project, true);
    assert.match(complete, /Other project/);
    const output = writeAudit(dir, "audit.md", complete);
    assert.equal(readFileSync(output, "utf8"), complete);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeAudit(dir, "audit.md", "overwrite"), /EEXIST/);
    symlinkSync(output, join(dir, "linked.md"));
    assert.throws(() => writeAudit(dir, "linked.md", "overwrite"), /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), complete);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("approved audit batches validate snapshots and atomically apply linked cross-project changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-audit-batch-"));
  const store = new MemoryStore(join(dir, "db.sqlite"));
  const origin = { harness: "test", session: null, actor: "user" as const };
  const add = (scope: string, text: string) => store.add(scope, { text, evidence: "Evidence", basis: "user_request" }, origin).lesson;
  try {
    const project = join(dir, "project"), other = join(dir, "other");
    const predecessor = add(project, "Linked predecessor");
    const linked = store.supersede(project, predecessor.id, { text: "Linked successor", evidence: "Evidence", basis: "user_request" }, origin);
    const archived = add(other, "Archive me");
    const staleCandidate = add(other, "Move out and back");
    const snapshot = store.auditSnapshot(project, true);
    const results = store.applyAudit(snapshot, [
      { id: archived.id, action: "archive", reason: "reviewed" },
      { id: linked.id, action: "move_global", reason: "shared" },
    ], origin);
    assert.equal(results.find((result) => result.lesson.id === linked.id)?.moved, 2);
    assert.equal(store.get(GLOBAL_SCOPE, linked.id).scope, GLOBAL_SCOPE);
    assert.equal(store.get(GLOBAL_SCOPE, predecessor.id).scope, GLOBAL_SCOPE);
    assert.ok(store.history(GLOBAL_SCOPE, predecessor.id).events.some((event) => event.action === "move"));
    assert.throws(() => store.applyAudit(snapshot, [{ id: linked.id, action: "archive", reason: "stale" }], origin), /stale/);
    const aba = store.auditSnapshot(other, true);
    store.moveLesson(other, staleCandidate.id, "/temporary", origin);
    store.moveLesson("/temporary", staleCandidate.id, other, origin);
    assert.throws(() => store.applyAudit(aba, [{ id: staleCandidate.id, action: "archive", reason: "ABA" }], origin), /stale/);
    const fresh = store.auditSnapshot(other, true);
    assert.throws(() => store.applyAudit(fresh, [{ id: staleCandidate.id, action: "archive", reason: "model" }], { ...origin, actor: "model" }), /user actor/);
    assert.throws(() => store.applyAudit(fresh, [
      { id: staleCandidate.id, action: "archive", reason: "one" }, { id: staleCandidate.id, action: "archive", reason: "two" },
    ], origin), /duplicate/);
    assert.throws(() => store.applyAudit(fresh, [{ id: 999999, action: "archive", reason: "no" }], origin), /outside snapshot/);

    const moving = add(project, "Move chain");
    const duplicate = add(GLOBAL_SCOPE, "Destination collision");
    const collisionMover = add(project, "Destination collision");
    const beforeHistory = store.history(project, moving.id).events.length;
    const rollbackSnapshot = store.auditSnapshot(project, true);
    assert.throws(() => store.applyAudit(rollbackSnapshot, [
      { id: moving.id, action: "archive", reason: "must roll back" },
      { id: collisionMover.id, action: "move_global", reason: "collision" },
    ], origin), /Duplicate active text/);
    assert.equal(store.get(project, moving.id).archived, false);
    assert.equal(store.history(project, moving.id).events.length, beforeHistory);
    assert.equal(store.get(GLOBAL_SCOPE, duplicate.id).scope, GLOBAL_SCOPE);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
