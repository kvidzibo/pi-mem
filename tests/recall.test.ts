import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { databasePath } from "../src/config.ts";
import { runMemory } from "../src/operations.ts";
import { CONTEXT_BYTES, memoryContext, RESULT_BYTES } from "../src/presentation.ts";
import { MemoryStore, type Page } from "../src/store.ts";

test("database path precedence is env, global extension config, then default; bad config fails visibly", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(databasePath(dir, {}), join(dir, "memory.sqlite3"));
  writeFileSync(join(dir, "pi-mem.json"), JSON.stringify({ databasePath: "data/lessons.sqlite3" }));
  assert.equal(databasePath(dir, {}), join(dir, "data", "lessons.sqlite3"));
  assert.equal(databasePath(dir, { PI_MEMORY_DB: "~/shared.sqlite3" }, "/test/home"), "/test/home/shared.sqlite3");
  writeFileSync(join(dir, "pi-mem.json"), "not JSON");
  assert.throws(() => databasePath(dir, {}));
  assert.equal(databasePath(dir, { PI_MEMORY_DB: "/explicit.sqlite3" }), "/explicit.sqlite3");
  assert.throws(() => databasePath(dir, { PI_MEMORY_DB: "" }), /nonempty/);
});

test("recall and paged search stay byte-bounded without deleting excess lessons", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-recall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new MemoryStore(join(dir, "db.sqlite3"));
  t.after(() => db.close());
  const origin = { harness: "test", session: null };
  db.addMany("/project", Array.from({ length: 31 }, (_, i) => ({
    text: `${i}: ${"记".repeat(1100)}`, evidence: "证".repeat(500), basis: "user_request" as const,
  })), origin);
  const context = memoryContext("/project", db.list("/project"));
  assert.ok(Buffer.byteLength(context.text) <= CONTEXT_BYTES);
  assert.ok(context.loaded > 0 && context.loaded < 30);
  const ids = new Set<string>();
  let offset: number | null = 0;
  do {
    const page = runMemory(db, "/project", { action: "search", query: "记", offset }, origin) as Page;
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RESULT_BYTES);
    for (const row of page.lessons) ids.add(row.id);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(ids.size, 31);
  assert.equal(db.list("/project").total, 31);
  assert.throws(() => runMemory(db, "/project", { action: "add", text: "Missing evidence", basis: "validated_fix" }, origin), /evidence/);
});
