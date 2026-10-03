import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { Backups, backupFolder, backupPeriod, backupReport, backupStatsText } from "../src/backups.ts";
import { MemoryStore } from "../src/store.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-backups-"));
  const path = join(dir, "memory.sqlite3");
  const store = new MemoryStore(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, path, store };
}
const local = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();

test("private backup includes committed WAL, every scope, and retained history", async (t) => {
  const { path, store } = setup(t);
  const reader = new DatabaseSync(path);
  reader.exec("BEGIN");
  reader.prepare("SELECT count(*) FROM lessons").get(); // Pin a reader before all writes; they remain in WAL.
  const input = (text: string) => ({ text, evidence: "Verified in testing.", basis: "validated_fix" as const });
  const source = { harness: "test", session: "one" };
  const old = store.add("/project", input("Old project lesson"), source).lesson;
  const replacement = store.supersede("/project", old.id, input("Current project lesson"), source);
  store.add("global", input("Global lesson"), source);
  store.add("/elsewhere", input("Other project lesson"), source);
  assert.ok(statSync(`${path}-wal`).size > 0);
  const backups = new Backups(path);
  let info;
  try { info = await backups.create(false, local(2024, 1, 1)); } finally { reader.exec("ROLLBACK"); reader.close(); }
  assert.ok(info);
  assert.equal(statSync(info.path).mode & 0o777, 0o600);
  assert.deepEqual([info.active, info.archived], [3, 1]);
  const snapshot = new DatabaseSync(info.path, { readOnly: true });
  try {
    assert.equal(snapshot.prepare("SELECT count(*) AS n FROM lessons").get()!.n, 4);
    assert.equal(snapshot.prepare("SELECT supersedes_id FROM lessons WHERE id = ?").get(replacement.id)!.supersedes_id, old.id);
    assert.deepEqual(snapshot.prepare("SELECT action FROM activity WHERE lesson_id = ? ORDER BY id").all(old.id).map(r => r.action), ["create", "supersede"]);
    assert.equal(snapshot.prepare("PRAGMA quick_check").get()!.quick_check, "ok");
  } finally { snapshot.close(); }
  assert.match(backupReport(info, info.size), /4 lessons \(3 active, 1 archived\)/);
  assert.match(backupStatsText(backups.stats()), /No automatic deletion/);
  assert.equal(backups.stats().files, 1);
  assert.equal(backups.stats().lastExists, true);
});

test("calendar schedules persist per database and selected folder", async (t) => {
  const { dir, path } = setup(t);
  const a = join(dir, "a"), b = join(dir, "b"); mkdirSync(a); mkdirSync(b);
  const backups = new Backups(path);
  assert.equal(backups.settings().frequency, "off");
  assert.equal(await backups.create(true, local(2024, 1, 1)), undefined);
  assert.equal(existsSync(backups.statePath), false);
  backups.configure({ frequency: "daily", folder: a });
  await backups.create(true, local(2024, 1, 1));
  assert.equal(await backups.create(true, local(2024, 1, 1, 23)), undefined);
  assert.ok(await backups.create(true, local(2024, 1, 2)));
  backups.configure({ frequency: "weekly" });
  assert.equal(await backups.create(true, local(2024, 1, 7)), undefined);
  assert.ok(await backups.create(true, local(2024, 1, 8)));
  backups.configure({ frequency: "monthly" });
  assert.ok(await backups.create(true, local(2024, 9, 30)));
  assert.ok(await backups.create(true, local(2024, 10, 1)));
  assert.equal(await backups.create(true, local(2024, 10, 31)), undefined);
  assert.ok(await backups.create(true, local(2025, 1, 1)));
  backups.configure({ folder: b });
  assert.deepEqual(new Backups(path).settings(), { frequency: "monthly", folder: b });
  assert.equal(backups.stats().last, null);
  assert.ok(await backups.create(true, local(2025, 1, 1)));
  backups.configure({ folder: a });
  assert.equal(await backups.create(true, local(2025, 1, 1)), undefined);
  assert.equal(backupPeriod("weekly", local(2025, 1, 1)), "2024-12-30");
  assert.equal(backupPeriod("monthly", local(2024, 12, 31)), "2024-12");
  assert.equal(backupFolder(dir, "  ./a "), a);
  assert.throws(() => backupFolder(dir, "\n"));
});

test("folder statistics exclude symlinks, preserve files, and report missing backups", async (t) => {
  const { dir, path } = setup(t);
  const folder = join(dir, "backups"); mkdirSync(folder);
  const backups = new Backups(path); backups.configure({ folder });
  writeFileSync(join(folder, "notes"), "keep");
  mkdirSync(join(folder, "nested")); writeFileSync(join(folder, "nested", "other"), "123");
  symlinkSync(folder, join(folder, "loop"));
  const first = await backups.create();
  assert.ok(first);
  assert.equal(backups.stats().bytes, 7 + first.size);
  const second = await backups.create();
  assert.ok(second);
  assert.equal(backups.stats().files, 2);
  assert.equal(readFileSync(join(folder, "notes"), "utf8"), "keep");
  rmSync(second.path);
  assert.equal(backups.stats().lastExists, false);
  assert.match(backupStatsText(backups.stats()), /\(missing\)/);
  assert.equal(existsSync(first.path), true);
});

test("failed automatic backup releases its claim without advancing the schedule", async (t) => {
  const { dir, path } = setup(t);
  const folder = join(dir, "bad"); mkdirSync(folder);
  const backups = new Backups(path); backups.configure({ frequency: "daily", folder });
  rmSync(folder, { recursive: true }); writeFileSync(folder, "not a directory");
  const at = local(2024, 1, 1);
  await assert.rejects(backups.create(true, at));
  rmSync(folder); mkdirSync(folder);
  assert.equal(backups.stats().last, null);
  assert.ok(await backups.create(true, at));
});

test("simultaneous startup requests share a claim while statistics remain readable", async (t) => {
  const { dir, path } = setup(t);
  const backups = new Backups(path); backups.configure({ frequency: "daily" });
  const first = backups.create(true, local(2024, 1, 1));
  assert.equal(backups.stats().last, null, "statistics must not acquire the operation lock");
  const results = await Promise.all([first, new Backups(path).create(true, local(2024, 1, 1))]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(backups.stats().files, 1);
  const script = `import {Backups} from ${JSON.stringify(new URL("../src/backups.ts", import.meta.url).href)};
    console.log(await new Backups(process.argv[1]).create(true, ${local(2024, 1, 2)}) ? "created" : "skipped");`;
  const start = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, path],
    { env: { PATH: process.env.PATH, HOME: dir }, timeout: 10000 });
  const processes = await Promise.all([start(), start()]);
  assert.deepEqual(processes.map(p => p.stdout.trim()).sort(), ["created", "skipped"]);
  assert.equal(backups.stats().files, 2);
});
