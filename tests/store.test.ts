import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_LIMITS } from "../src/limits.ts";
import { MemoryStore } from "../src/store.ts";

const source = { harness: "test", session: "session-one" };
const input = { text: "Use the project-local environment.", evidence: "Confirmed the test command succeeds there.", basis: "validated_fix" as const };
function temporary(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "memory.sqlite3");
}

test("lessons persist, deduplicate active text, retain predecessors and stay project-scoped", (t) => {
  const path = temporary(t);
  let db = new MemoryStore(path);
  t.after(() => db.close());
  const saved = db.add("/projects/a", input, source);
  assert.equal(saved.created, true);
  assert.equal(saved.lesson.id, 1);
  assert.deepEqual(db.add("/projects/a", { ...input, text: "Use  the project-local\nenvironment." }, source),
    { ...saved, created: false });
  assert.equal(db.list("/projects/ab").total, 0);
  assert.equal(db.list("/projects/a/subdir").total, 0);
  assert.throws(() => db.get("/projects/b", saved.lesson.id), /not found/);
  assert.throws(() => db.supersede("/projects/b", saved.lesson.id, input, source), /not found/);
  assert.throws(() => db.archive("/projects/b", saved.lesson.id), /not found/);
  const replacementSource = { harness: "test", session: "session-two" };
  const replacement = db.supersede("/projects/a", saved.lesson.id,
    { ...input, text: "Use .venv/bin/python.", evidence: "Verified the Python command." }, replacementSource);
  assert.notEqual(replacement.id, saved.lesson.id);
  assert.equal(replacement.supersedes_id, saved.lesson.id);
  assert.ok(replacement.created_at > saved.lesson.created_at);
  assert.equal(replacement.source_session, "session-two");
  assert.deepEqual(db.get("/projects/a", saved.lesson.id),
    { ...saved.lesson, archived: true, archived_at: replacement.created_at });
  assert.deepEqual([...db.recall("/projects/a").lessons], [replacement]);
  const successor = db.supersede("/projects/a", replacement.id, { ...input, text: "Run .venv/bin/python -m pytest." }, source);
  assert.equal(successor.supersedes_id, replacement.id);
  const { lesson: archived, changed } = db.archive("/projects/a", successor.id);
  assert.equal(changed, true);
  assert.ok(archived.archived_at! >= successor.created_at);
  assert.deepEqual(db.archive("/projects/a", successor.id), { lesson: archived, changed: false }, "repeated archive must not change its timestamp or count again");
  assert.deepEqual(db.sessionCreations("/projects/a", source), { added: 2, superseded: 1 });
  assert.deepEqual(db.sessionCreations("/projects/a", replacementSource), { added: 1, superseded: 1 });
  assert.equal(db.list("/projects/a").total, 0);
  const fresh = db.add("/projects/a", { ...input, text: successor.text }, source);
  assert.equal(fresh.created, true);
  assert.notEqual(fresh.lesson.id, successor.id);
  assert.equal(fresh.lesson.supersedes_id, null);
  db.close();
  db = new MemoryStore(path);
  assert.deepEqual(db.get("/projects/a", successor.id), archived);
  assert.equal(db.list("/projects/a", { state: "all" }).total, 4);
  assert.equal(db.list("/projects/a", { state: "archived" }).total, 3);
  assert.equal(db.list("/projects/a", { query: "PYTHON" }).lessons[0].id, fresh.lesson.id);
  assert.equal(db.list("/projects/a", { query: "%' OR 1=1 --" }).total, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("fresh schema has no priority and rejects previous versions without writes", (t) => {
  const path = temporary(t);
  const db = new MemoryStore(path, { ...DEFAULT_LIMITS, maxRecallLessons: 1 });
  t.after(() => db.close());
  const raw = new DatabaseSync(path);
  try {
    assert.equal(Number(raw.prepare("PRAGMA user_version").get()!.user_version), 9);
    assert.equal(raw.prepare("PRAGMA table_info(lessons)").all().some((column) => column.name === "priority"), false);
    assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='priority_changes'").get(), undefined);
    db.add("/project", input, source);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    const newest = db.add("/project", { ...input, text: "Newest lesson." }, source).lesson;
    assert.deepEqual([...db.recall("/project").lessons].map((lesson) => lesson.id), [newest.id]);
    const before = raw.prepare("SELECT * FROM lessons ORDER BY id").all();
    raw.exec("PRAGMA user_version = 8");
    assert.throws(() => new MemoryStore(path), /schema|version/i);
    assert.deepEqual(raw.prepare("SELECT * FROM lessons ORDER BY id").all(), before);
    assert.equal(Number(raw.prepare("PRAGMA user_version").get()!.user_version), 8);
  } finally { raw.close(); }
});

test("scope listing and moves include archived lessons and preserve records atomically", (t) => {
  const path = temporary(t);
  const db = new MemoryStore(path);
  const raw = new DatabaseSync(path);
  t.after(() => { raw.close(); db.close(); });
  const predecessor = db.add("/source", input, source).lesson;
  const successor = db.supersede("/source", predecessor.id, { ...input, text: "Replacement lesson." }, source);
  const archived = db.add("/archived-only", input, source).lesson;
  db.archive("/archived-only", archived.id);
  const before = db.list("/source", { state: "all" }).lessons;
  assert.deepEqual(db.listScopes(), ["/archived-only", "/source"]);
  assert.equal(db.moveScope("/source", "/destination"), 2);
  assert.deepEqual(db.list("/destination", { state: "all" }).lessons,
    before.map((row) => ({ ...row, scope: "/destination" })));
  assert.deepEqual(db.listScopes(), ["/archived-only", "/destination"]);
  assert.throws(() => db.moveScope("/missing", "/new"), /Source scope/);
  assert.throws(() => db.moveScope("/destination", "/archived-only"), /occupied/);
  assert.throws(() => db.moveScope("/destination", "/destination"), /differ/);
  assert.throws(() => db.moveScope("relative", "/new"), /absolute/);
  assert.throws(() => raw.exec("UPDATE lessons SET scope = '/tampered' WHERE id = 1"), /immutable/);
  assert.equal(db.get("/destination", successor.id).supersedes_id, predecessor.id);
});

test("moveLesson moves an archived lesson's full chain and rolls back destination duplicates", (t) => {
  const path = temporary(t);
  const db = new MemoryStore(path);
  const raw = new DatabaseSync(path);
  t.after(() => { raw.close(); db.close(); });
  const first = db.add("/from", input, source).lesson;
  const middle = db.supersede("/from", first.id, { ...input, text: "Middle linked lesson." }, source);
  const last = db.supersede("/from", middle.id, { ...input, text: "Last linked lesson." }, source);
  const unrelated = db.add("/from", { ...input, text: "Unrelated lesson." }, source).lesson;
  const selected = db.get("/from", middle.id);
  assert.equal(selected.archived, true);
  const chain = [first, middle, last].map((row) => db.get("/from", row.id));
  for (const badId of [0, true, "1", 1.5]) {
    assert.throws(() => db.moveLesson("/from", badId as number, "/to"), /positive safe integer/);
  }
  assert.throws(() => db.moveLesson("/elsewhere", middle.id, "/to"), /not found/);
  assert.throws(() => db.moveLesson("/from", middle.id, "/from"), /must differ/);
  assert.throws(() => db.moveLesson("/from", middle.id, "relative"), /absolute project path/);
  assert.equal(db.moveLesson("/from", middle.id, "/to"), 3);
  for (const row of chain) {
    assert.deepEqual(db.get("/to", row.id), { ...row, scope: "/to" });
    assert.throws(() => db.get("/from", row.id), /not found/);
  }
  assert.deepEqual(db.get("/from", unrelated.id), unrelated);
  const duplicate = db.add("/to", { ...input, text: "Collision text." }, source).lesson;
  const active = db.add("/from", { ...input, text: "Collision   text." }, source).lesson;
  assert.throws(() => db.moveLesson("/from", active.id, "/to"), /Duplicate active text/);
  assert.deepEqual(db.get("/from", active.id), active);
  assert.deepEqual(db.get("/to", duplicate.id), duplicate);
  raw.exec(`CREATE TRIGGER fail_move BEFORE UPDATE OF scope ON lessons
    WHEN NEW.scope = '/blocked' BEGIN SELECT RAISE(ABORT, 'blocked move'); END;`);
  assert.throws(() => db.moveLesson("/to", last.id, "/blocked"), /blocked move/);
  for (const row of chain) assert.deepEqual(db.get("/to", row.id), { ...row, scope: "/to" });
  assert.throws(() => raw.exec("UPDATE lessons SET scope = '/tampered' WHERE id = 1"), /immutable/);
  const reopened = new MemoryStore(path);
  try {
    assert.equal(reopened.get("/to", last.id).supersedes_id, middle.id);
  } finally { reopened.close(); }
});

test("two connections cannot supersede an archived predecessor or lose its content", (t) => {
  const path = temporary(t);
  const one = new MemoryStore(path);
  const two = new MemoryStore(path);
  t.after(() => { one.close(); two.close(); });
  const saved = one.add("/project", input, source).lesson;
  const successor = two.supersede("/project", saved.id, { ...input, text: "New verified lesson." }, source);
  assert.throws(() => one.supersede("/project", saved.id, input, source), /already archived/);
  one.archive("/project", saved.id);
  assert.equal(one.get("/project", saved.id).text, saved.text);
  assert.deepEqual([...one.recall("/project").lessons], [successor]);
  assert.equal(one.list("/project", { state: "all" }).total, 2);
});

test("supersession rolls back on insertion failure and database guards preserve records", (t) => {
  const path = temporary(t);
  const db = new MemoryStore(path);
  const raw = new DatabaseSync(path);
  t.after(() => { raw.close(); db.close(); });
  const saved = db.add("/project", input, source).lesson;
  const other = db.add("/project", { ...input, text: "Another active lesson." }, source).lesson;
  assert.throws(() => db.supersede("/project", saved.id, other, source), /Duplicate active/);
  raw.exec(`CREATE TRIGGER fail_successor BEFORE INSERT ON lessons WHEN NEW.supersedes_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'Forced insertion failure'); END;`);
  assert.throws(() => db.supersede("/project", saved.id, { ...input, text: "Replacement." }, source), /Forced insertion failure/);
  assert.deepEqual(db.get("/project", saved.id), saved, "failed insert must roll back the predecessor's archive");
  assert.equal(db.list("/project", { state: "all" }).total, 2);
  raw.exec("DROP TRIGGER fail_successor");

  for (const sql of [
    "UPDATE lessons SET text = 'Overwritten'",
    "UPDATE lessons SET evidence = 'Overwritten'",
    "UPDATE lessons SET created_at = 0",
    "UPDATE lessons SET updated_at = 0, revision = revision + 1",
    "DELETE FROM lessons",
    "INSERT OR REPLACE INTO lessons SELECT * FROM lessons",
    `INSERT OR REPLACE INTO lessons (id, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at)
      SELECT 1000, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at FROM lessons LIMIT 1`,
  ]) assert.throws(() => raw.exec(sql), /immutable|cannot be deleted|cannot be replaced/);
  assert.throws(() => raw.exec(`INSERT OR REPLACE INTO lessons
    (rowid, id, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at)
    SELECT rowid, 1000, scope, 'Changed.', 'different-key', evidence, basis, source_harness, created_at, updated_at
    FROM lessons LIMIT 1`), /rowid/, "hidden rowid conflicts must not bypass retention guards");
  assert.deepEqual(db.get("/project", saved.id), saved);
  assert.deepEqual(db.get("/project", other.id), other);

  // Evidence-only corrections still get a new record, even when the normalized text is identical.
  const successor = db.supersede("/project", saved.id, { ...input, evidence: "Verified again." }, source);
  assert.notEqual(successor.id, saved.id);
  assert.equal(db.get("/project", saved.id).evidence, saved.evidence);
  assert.equal(successor.evidence, "Verified again.");
  assert.throws(() => raw.prepare(`INSERT OR REPLACE INTO lessons
    (id, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at, supersedes_id)
    VALUES (1000, '/project', 'Other text.', 'other-key', 'Verified.', 'user_request', 'test', 1, 1, ?)`)
    .run(saved.id), /cannot be replaced/);
  assert.deepEqual(db.get("/project", successor.id), successor);
  assert.throws(() => raw.prepare("UPDATE lessons SET archived = 0, archived_at = NULL WHERE id = ?").run(saved.id), /active-to-archived/);
  db.archive("/project", other.id);
  assert.throws(() => raw.prepare(`INSERT INTO lessons
    (id, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at, supersedes_id)
    VALUES (1000, '/other', 'Other text.', 'other-key', 'Verified.', 'user_request', 'test', 1, 1, ?)`)
    .run(other.id), /same project/);
  assert.equal(db.list("/project", { state: "all" }).total, 3);
});

test("independent processes can initialize and write the same WAL database", async (t) => {
  const path = temporary(t);
  const module = new URL("../src/store.ts", import.meta.url).href;
  const run = promisify(execFile);
  await Promise.all(["one", "two"].map((name) => run(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e",
    `import { MemoryStore } from ${JSON.stringify(module)};
     const db = new MemoryStore(${JSON.stringify(path)});
     db.add('/project', ${JSON.stringify(input)}, ${JSON.stringify(source)});
     db.add('/project', { ...${JSON.stringify(input)}, text: ${JSON.stringify(name)} }, ${JSON.stringify(source)});
     db.close();`,
  ], { timeout: 15000 })));
  const db = new MemoryStore(path);
  t.after(() => db.close());
  assert.equal(db.list("/project").total, 3);
});

test("WAL conversion retries a concurrent reader but fails within a bounded wait", async (t) => {
  const path = temporary(t);
  const seed = new MemoryStore(path);
  const saved = seed.add("/project", input, source).lesson;
  seed.close();
  let reader = new DatabaseSync(path);
  t.after(() => reader.close());
  const module = new URL("../src/store.ts", import.meta.url).href;
  const run = promisify(execFile);
  for (const release of [true, false]) {
    reader.exec("PRAGMA journal_mode = DELETE;");
    const gate = `${path}.${release}.ready`;
    let locked = false;
    let ready = false;
    let busy = false;
    const started = performance.now();
    const opening = run(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { existsSync } from 'node:fs';
      import { MemoryStore } from ${JSON.stringify(module)};
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) {
        const result = exec.call(this, sql);
        if (sql === 'COMMIT') {
          console.log('SCHEMA_READY');
          const deadline = performance.now() + 5000;
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!existsSync(${JSON.stringify(gate)})) {
            assert.ok(performance.now() < deadline, 'reader barrier timed out');
            Atomics.wait(wait, 0, 0, 5);
          }
        }
        return result;
      };
      const prepare = DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = prepare.call(this, sql);
        if (sql !== 'PRAGMA journal_mode = WAL') return statement;
        return { get() {
          try { return statement.get(); }
          catch (error) { if (error.errcode === 5) console.log('WAL_BUSY'); throw error; }
        } };
      };
      try {
        const db = new MemoryStore(${JSON.stringify(path)});
        assert.deepEqual(db.get('/project', ${saved.id}), ${JSON.stringify(saved)});
        db.close();
        console.log('OPENED');
      } catch (error) { console.error('OPEN_ERROR:' + error.errcode); process.exitCode = 1; }
    `], { timeout: 10000, env: {} });
    let output = "";
    opening.child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (!ready && output.includes("SCHEMA_READY")) {
        reader.exec("BEGIN;");
        reader.prepare("SELECT * FROM lessons").get();
        locked = true;
        ready = true;
        writeFileSync(gate, "ready");
      }
      if (!output.includes("WAL_BUSY")) return;
      busy = true;
      if (release && locked) { reader.exec("ROLLBACK"); locked = false; }
    });
    try {
      if (release) assert.match((await opening).stdout, /OPENED/);
      else await assert.rejects(opening, (error: unknown) => /OPEN_ERROR:5/.test((error as { stderr: string }).stderr));
      assert.ok(busy, "the reader must force a real SQLITE_BUSY during WAL conversion");
      assert.ok(performance.now() - started < 8000, "persistent contention must not hang initialization");
    } finally { if (locked) reader.exec("ROLLBACK"); }
    reader.close();
    reader = new DatabaseSync(path);
    assert.equal(reader.prepare("PRAGMA journal_mode").get()!.journal_mode, release ? "wal" : "delete");
  }
});

test("unrelated databases are refused and invalid batches do not partially save", (t) => {
  const path = temporary(t);
  const unrelated = new DatabaseSync(path);
  unrelated.exec("CREATE TABLE important (value TEXT); INSERT INTO important VALUES ('keep');");
  unrelated.close();
  assert.throws(() => new MemoryStore(path), /Not a supported/);
  const check = new DatabaseSync(path);
  assert.equal(check.prepare("SELECT value FROM important").get()!.value, "keep");
  assert.equal(check.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  check.close();
  const db = new MemoryStore(path + ".new");
  t.after(() => db.close());
  assert.throws(() => db.addMany("/project", [input, { ...input, text: "x".repeat(1201) }], source), /text must/);
  assert.equal(db.list("/project").total, 0);
});
