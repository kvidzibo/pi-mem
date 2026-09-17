import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

test("lessons persist, deduplicate, stay project-scoped and archive without resurrection", (t) => {
  const path = temporary(t);
  let db = new MemoryStore(path);
  t.after(() => db.close());
  const saved = db.add("/projects/a", input, source);
  assert.equal(saved.created, true);
  assert.equal(db.add("/projects/a", { ...input, text: "Use  the project-local\nenvironment." }, source).created, false);
  assert.equal(db.list("/projects/ab").total, 0);
  assert.equal(db.list("/projects/a/subdir").total, 0);
  assert.throws(() => db.get("/projects/b", saved.lesson.id), /not found/);
  const edited = db.update("/projects/a", saved.lesson.id, 1, { ...input, text: "Use .venv/bin/python." }, source);
  assert.equal(edited.revision, 2);
  const archived = db.setArchived("/projects/a", edited.id, edited.revision, true);
  assert.equal(db.list("/projects/a").total, 0);
  assert.equal(db.add("/projects/a", { ...input, text: edited.text }, source).lesson.archived, true);
  db.close();
  db = new MemoryStore(path);
  assert.equal(db.get("/projects/a", edited.id).archived, true);
  db.setArchived("/projects/a", edited.id, archived.revision, false);
  assert.equal(db.list("/projects/a", { query: "PYTHON" }).lessons[0].text, edited.text);
  assert.equal(db.list("/projects/a", { query: "%' OR 1=1 --" }).total, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("two connections reject stale revisions instead of losing an update", (t) => {
  const path = temporary(t);
  const one = new MemoryStore(path);
  const two = new MemoryStore(path);
  t.after(() => { one.close(); two.close(); });
  const saved = one.add("/project", input, source).lesson;
  two.update("/project", saved.id, saved.revision, { ...input, text: "New verified lesson." }, source);
  assert.throws(() => one.update("/project", saved.id, saved.revision, input, source), /changed in another session/);
  assert.throws(() => one.setArchived("/project", saved.id, saved.revision, true), /changed in another session/);
  assert.equal(one.get("/project", saved.id).text, "New verified lesson.");
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
