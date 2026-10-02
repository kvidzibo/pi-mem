import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAudit, writeAudit } from "../src/audit.ts";
import { MemoryStore } from "../src/store.ts";

test("audit exports every active lesson across requested scopes and writes exclusively with private mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-audit-"));
  const store = new MemoryStore(join(dir, "db.sqlite"));
  try {
    const project = join(dir, "project");
    const other = join(dir, "other");
    for (let i = 0; i < 1002; i++) store.add(project, { text: `Lesson ${i} ${"detail ".repeat(8)}`, evidence: `Evidence ${i}`, basis: "validated_learning", priority: i === 0 ? 0 : 5 }, { harness: "test", session: null });
    store.add(other, { text: "Other project", evidence: "Evidence", basis: "user_request" }, { harness: "test", session: null });
    const old = store.add(project, { text: "Archived", evidence: "Evidence", basis: "user_request" }, { harness: "test", session: null }).lesson;
    store.archive(project, old.id);
    const simple = buildAudit(store, project);
    assert.ok(simple.length > 16 * 1024);
    assert.match(simple, /Lesson 1001/);
    const data = JSON.parse(simple.split("```json\n")[1].split("\n```")[0]);
    assert.equal(data[project].length, 1002);
    assert.equal(data[project][0].evidence, "Evidence 0");
    assert.equal(data[project][0].source_harness, "test");
    assert.doesNotMatch(simple, /Other project/);
    assert.doesNotMatch(simple, /Archived/);
    const complete = buildAudit(store, project, true);
    assert.match(complete, /Other project/);
    assert.match(complete, /"priority": 0/);
    const output = writeAudit(dir, "audit.md", complete);
    assert.equal(readFileSync(output, "utf8"), complete);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.throws(() => writeAudit(dir, "audit.md", "overwrite"), /EEXIST/);
    symlinkSync(output, join(dir, "linked.md"));
    assert.throws(() => writeAudit(dir, "linked.md", "overwrite"), /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), complete);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
