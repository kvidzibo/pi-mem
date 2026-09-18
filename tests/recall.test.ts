import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { databasePath, memoryConfig } from "../src/config.ts";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { importMarkdown } from "../src/markdown.ts";
import { runMemory } from "../src/operations.ts";
import { boundedPage, CONTEXT_BYTES, memoryContext, RESULT_BYTES } from "../src/presentation.ts";
import { MemoryStore } from "../src/store.ts";

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

test("word limits bound new writes and atomic imports without changing existing lessons", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-words-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const defaults = memoryConfig(dir, {});
  assert.equal(defaults.maxLessonWords, 20);
  assert.equal(defaults.maxEvidenceWords, 20);
  let db = new MemoryStore(defaults.databasePath);
  t.after(() => db.close());
  const origin = { harness: "test", session: null };
  const text = Array.from({ length: 20 }, (_, i) => `word${i}`).join("\u2003\t\n");
  const input = { text, evidence: text, basis: "user_request" as const };
  const saved = db.add(dir, input, origin).lesson;
  assert.throws(() => db.add(dir, { ...input, text: text + " extra" }, origin), /text exceeds 20 words/);
  assert.throws(() => db.add(dir, { ...input, evidence: text + " extra" }, origin), /evidence exceeds 20 words/);
  assert.throws(() => db.supersede(dir, saved.id, { ...input, text: text + " extra" }, origin), /text exceeds 20 words/);
  assert.deepEqual(db.get(dir, saved.id), saved);
  writeFileSync(join(dir, "lessons.md"), `- A valid new lesson.\n- ${text.replace(/\s+/gu, " ")} extra\n`);
  assert.throws(() => importMarkdown(db, dir, dir, "lessons.md", origin), /text exceeds 20 words/);
  assert.equal(db.list(dir).total, 1, "a rejected import must not partially save");
  db.close();

  writeFileSync(join(dir, "pi-mem.json"), JSON.stringify({ maxLessonWords: 21, maxEvidenceWords: 1 }));
  const custom = memoryConfig(dir, { PI_MEMORY_DB: defaults.databasePath });
  assert.equal(custom.maxLessonWords, 21, "a database override must not discard valid word settings");
  db = new MemoryStore(custom.databasePath, custom);
  const longer = db.add(dir, { ...input, text: text + " extra", evidence: "Verified." }, origin).lesson;
  assert.throws(() => db.add(dir, { ...input, evidence: "Two words" }, origin), /evidence exceeds 1 words/);
  db.close();
  db = new MemoryStore(defaults.databasePath);
  assert.deepEqual(db.get(dir, longer.id), longer, "lower limits must not rewrite or hide existing lessons");
  assert.equal(db.archive(dir, longer.id).archived, true);
  for (const maxLessonWords of [0, 1.5, "20", null]) {
    writeFileSync(join(dir, "pi-mem.json"), JSON.stringify({ maxLessonWords }));
    assert.throws(() => memoryConfig(dir, {}), /maxLessonWords must be a positive safe integer/);
  }
});

test("recall count is configurable below and above 30 without changing list pagination", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-count-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const defaults = memoryConfig(dir, {});
  assert.equal(defaults.maxRecallLessons, 30);
  let db = new MemoryStore(defaults.databasePath);
  t.after(() => db.close());
  db.addMany(dir, Array.from({ length: 31 }, (_, i) => ({
    text: `Lesson ${i}.`, evidence: "Verified.", basis: "user_request" as const,
  })), { harness: "test", session: null });
  assert.equal(memoryContext(dir, db.recall(dir)).loaded, 30);
  for (const maxRecallLessons of [2, 31]) {
    db.close();
    writeFileSync(join(dir, "pi-mem.json"), JSON.stringify({ maxRecallLessons }));
    const config = memoryConfig(dir, {});
    db = new MemoryStore(config.databasePath, config);
    const recalled = memoryContext(dir, db.recall(dir));
    assert.equal(recalled.loaded, maxRecallLessons);
    assert.equal(db.list(dir).lessons.length, 30);
    assert.equal(db.list(dir).total, 31);
  }
  writeFileSync(join(dir, "pi-mem.json"), JSON.stringify({ maxRecallLessons: 0 }));
  assert.throws(() => memoryConfig(dir, {}), /maxRecallLessons must be a positive safe integer/);
});

test("recall and paged search stay byte-bounded without deleting excess lessons", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-recall-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new MemoryStore(join(dir, "db.sqlite3"), { ...DEFAULT_LIMITS, maxRecallLessons: 1000 });
  t.after(() => db.close());
  const origin = { harness: "test", session: null };
  db.addMany("/project", Array.from({ length: 31 }, (_, i) => ({
    text: `${i}: ${"记".repeat(1100)}`, evidence: "证".repeat(500), basis: "user_request" as const,
  })), origin);
  const context = memoryContext("/project", db.recall("/project"));
  assert.ok(Buffer.byteLength(context.text) <= CONTEXT_BYTES);
  assert.ok(context.loaded > 0 && context.loaded < 30);
  assert.match(context.text, /Omitted lessons remain stored/);
  assert.doesNotMatch(context.text, /memory list|memory search|revision/);
  const ids = new Set<string>();
  let offset: number | null = 0;
  do {
    const page = boundedPage(db.list("/project", { query: "记", offset }), offset);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RESULT_BYTES);
    for (const row of page.lessons) ids.add(row.id);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(ids.size, 31);
  assert.equal(db.list("/project").total, 31);
  assert.throws(() => runMemory(db, "/project", { action: "add", text: "Missing evidence", basis: "validated_fix" }, origin), /evidence/);
  assert.equal(db.add("/project", { text: "A later write succeeds.", evidence: "Verified.", basis: "user_request" }, origin).created, true,
    "breaking recall at the byte budget must release its cursor before later writes");
});
