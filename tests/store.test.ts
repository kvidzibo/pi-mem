import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
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
  assert.equal(saved.lesson.legacy_id, null);
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
  const archived = db.archive("/projects/a", successor.id);
  assert.ok(archived.archived_at! >= successor.created_at);
  assert.deepEqual(db.archive("/projects/a", successor.id), archived, "repeated archive must not change its timestamp");
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

for (const version of [1, 2, 3]) test(`schema ${version} upgrades preserve legacy data, references and creation-order recall`, (t) => {
  const path = temporary(t);
  const legacy = new DatabaseSync(path);
  t.after(() => legacy.close());
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE lessons (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 1200),
      text_key TEXT NOT NULL,
      evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND 600),
      basis TEXT NOT NULL CHECK(basis IN ('validated_fix', 'user_request', 'import'${version >= 2 ? ", 'validated_learning'" : ""})),
      source_harness TEXT NOT NULL,
      source_session TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
      ${version === 3 ? "archived_at INTEGER, supersedes_id TEXT UNIQUE REFERENCES lessons(id)" : "UNIQUE(scope, text_key)"}
    ) ${version === 3 ? "WITHOUT ROWID" : ""};
    CREATE INDEX lessons_recall ON lessons(scope, archived, updated_at DESC, id);
    PRAGMA application_id = ${0x504d454d};
    PRAGMA user_version = ${version};
  `);
  const bases = ["validated_fix", "user_request", "import", ...(version >= 2 ? ["validated_learning"] : [])];
  const ids = bases.map((_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  for (const [i, basis] of bases.entries()) {
    const text = `Legacy ${basis} lesson.`;
    legacy.prepare(`INSERT INTO lessons
      (id, scope, text, text_key, evidence, basis, source_harness, source_session, created_at, updated_at, revision, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ids[i], version === 3 && i === 3 ? "/other" : "/project", text,
      createHash("sha256").update(text).digest("hex"), "Previously verified.",
      basis, "legacy", i === 0 ? null : "old-session", 100 + i, 300 - i, 3 + i,
      i === 0 || (version === 3 && i === 1) ? 1 : 0,
    );
    if (version === 3) legacy.prepare("UPDATE lessons SET archived_at = ?, supersedes_id = ? WHERE id = ?")
      .run(i < 2 ? 150 + i : null, i === 1 || i === 2 ? ids[i - 1] : null, ids[i]);
  }
  if (version === 3) legacy.exec(`
    CREATE UNIQUE INDEX lessons_active_text ON lessons(scope, text_key) WHERE archived = 0;
    CREATE TRIGGER lessons_immutable BEFORE UPDATE OF text ON lessons
      BEGIN SELECT RAISE(ABORT, 'immutable'); END;
    CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons
      BEGIN SELECT RAISE(ABORT, 'cannot be deleted'); END;
  `);
  const original = legacy.prepare("SELECT * FROM lessons ORDER BY created_at, id").all();
  const mapping = new Map(original.map((row, i) => [row.id, i + 1]));
  const expected = original.map((row) => ({ ...row, id: mapping.get(row.id), legacy_id: row.id,
    archived_at: row.archived_at ?? null, supersedes_id: row.supersedes_id ? mapping.get(row.supersedes_id) : null }));

  let db = new MemoryStore(path);
  t.after(() => db.close());
  const migrated = new DatabaseSync(path);
  try {
    assert.deepEqual(migrated.prepare("SELECT * FROM lessons ORDER BY id").all().map((row) => ({ ...row })), expected);
    assert.equal(migrated.prepare("PRAGMA user_version").get()!.user_version, 4);
    assert.equal(migrated.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'lessons_recall'").get());
    assert.equal(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'lessons_previous'").get(), undefined);
    assert.throws(() => legacy.exec("UPDATE lessons SET text = 'Old client overwrite' WHERE id = 2"), /immutable/);
    assert.throws(() => legacy.exec("UPDATE lessons SET legacy_id = 'Changed' WHERE id = 2"), /immutable/);
    assert.throws(() => legacy.exec("UPDATE lessons SET archived = 0 WHERE id = 1"), /active-to-archived/);
    assert.throws(() => legacy.exec(`INSERT OR REPLACE INTO lessons
      (id, legacy_id, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at)
      SELECT 999, legacy_id, scope, 'Changed.', 'different-key', evidence, basis, source_harness, created_at, updated_at
      FROM lessons LIMIT 1`), /cannot be replaced/, "legacy alias conflicts must not delete retained rows");
    assert.throws(() => legacy.exec(`INSERT INTO lessons
      (id, scope, text, text_key, evidence, basis, source_harness, created_at, updated_at)
      VALUES ('old-client-uuid', '/project', 'Old client.', 'new-key', 'Verified.', 'user_request', 'test', 1, 1)`),
      /CHECK constraint/, "an already-open old client cannot insert UUIDs after migration");
  } finally {
    migrated.close();
  }
  for (const row of original) {
    const id = mapping.get(row.id)!;
    assert.deepEqual(db.get(String(row.scope), String(row.id)), db.get(String(row.scope), id));
    assert.deepEqual(db.get(String(row.scope), `#${id}`), db.get(String(row.scope), id));
    assert.throws(() => db.get("/missing", String(row.id)), /not found in this project/);
  }
  assert.deepEqual([...db.recall("/project").lessons].map((row) => row.id),
    original.filter((row) => row.scope === "/project" && row.archived === 0).reverse().map((row) => mapping.get(row.id)),
    "creation time, not legacy updated time, determines recall");
  const archived = db.get("/project", ids[0]);
  assert.equal(archived.archived_at, version === 3 ? 150 : null, "migration must preserve known/unknown archive dates");
  const fresh = db.add("/project", archived, source);
  assert.equal(fresh.created, true);
  assert.equal(fresh.lesson.id, original.length + 1);
  assert.deepEqual(db.get("/project", archived.id), archived);
  const predecessor = db.get("/project", ids[2]);
  const successor = db.supersede("/project", ids[2],
    { ...input, text: "Build assets before packaging.", basis: "validated_learning" }, source);
  assert.equal(successor.supersedes_id, predecessor.id, "superseding by UUID must link the integer predecessor");
  assert.equal(db.archive("/project", ids[2]).id, predecessor.id);
  db.close();
  db = new MemoryStore(path);
  assert.deepEqual(db.get("/project", successor.id), successor);
  assert.equal(successor.basis, "validated_learning");
  assert.equal(db.get("/project", ids[2]).text, predecessor.text);
  assert.deepEqual(db.get("/project", ids[0]), archived, "reopening must not renumber records");
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
