import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportMarkdown, exportPath, importMarkdown, parseMarkdown, readMarkdownSource, retireSource } from "../src/markdown.ts";
import { MemoryStore } from "../src/store.ts";

test("explicit Markdown migration is atomic, repeatable, confined, and preserves its source", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-markdown-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new MemoryStore(join(dir, "db.sqlite3"));
  t.after(() => db.close());
  const source = "# Lessons\n\n- Use local tools.\n  The verified command is `npm test`.\n\n2. Keep project lessons isolated.\n";
  const file = join(dir, "MEMORY.md");
  writeFileSync(file, source);
  const origin = { harness: "test", session: null };
  const imported = importMarkdown(db, dir, dir, "MEMORY.md", origin);
  assert.equal(imported.imported, 2);
  assert.equal(readFileSync(file, "utf8"), source);
  assert.equal(importMarkdown(db, dir, dir, "MEMORY.md", origin).existing, 2);
  const output = exportPath(dir, dir, "export.md");
  assert.equal(exportMarkdown(db, dir, output), 2);
  assert.deepEqual(new Set(parseMarkdown(readFileSync(output, "utf8"))), new Set(parseMarkdown(source)));
  assert.throws(() => exportMarkdown(db, dir, output), /EEXIST/);
  assert.throws(() => parseMarkdown("# Lessons\n\nA paragraph that must not be discarded.\n- item"), /Unsupported Markdown/);
  writeFileSync(file, `- Valid new item\n- ${"x".repeat(1201)}\n`);
  assert.throws(() => importMarkdown(db, dir, dir, "MEMORY.md", origin), /imported lesson/);
  assert.equal(db.list(dir).total, 2);
  symlinkSync("/etc/hosts", join(dir, "outside.md"));
  assert.throws(() => importMarkdown(db, dir, dir, "outside.md", origin), /inside the current project/);
  assert.throws(() => exportPath(dir, dir, "../outside.md"), /inside the current project/);
});

test("source replacement during removal is recovered without overwriting a newer writer", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-remove-race-"));
  const file = join(dir, "MEMORY.md");
  const rename = fs.renameSync;
  let thirdWriter = false;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); });
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    // Replace the source after its final pre-move check, then optionally occupy the vacated path.
    rename(from, join(dir, "writer-preserved-original.md"));
    writeFileSync(from, "- Concurrent replacement.\n");
    rename(from, to);
    if (thirdWriter) writeFileSync(from, "- Newest writer.\n");
  });
  syncBuiltinESMExports();
  for (thirdWriter of [false, true]) {
    writeFileSync(file, "- Approved original.\n");
    const source = readMarkdownSource(dir, dir, file);
    const result = retireSource(dir, source);
    assert.match(result.cleanupError!, /Source changed during removal/);
    assert.equal(result.sourceRetained, true);
    assert.equal(readFileSync(file, "utf8"), thirdWriter ? "- Newest writer.\n" : "- Concurrent replacement.\n");
    assert.equal(readFileSync(result.movedSource!, "utf8"), "- Concurrent replacement.\n");
    assert.equal(readFileSync(result.backup, "utf8"), "- Approved original.\n");
    assert.equal(readFileSync(join(dir, "writer-preserved-original.md"), "utf8"), "- Approved original.\n");
    writeFileSync(file, "- Subsequent edit.\n");
    assert.equal(readFileSync(result.backup, "utf8"), "- Approved original.\n", "the reviewed backup must not share the live file's inode");
  }
});

test("import rejects a named pipe without blocking the process", { skip: process.platform === "win32" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-fifo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("mkfifo", [join(dir, "input.md")]);
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { MemoryStore } from ${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)};
    import { importMarkdown } from ${JSON.stringify(new URL("../src/markdown.ts", import.meta.url).href)};
    const db = new MemoryStore(${JSON.stringify(join(dir, "db.sqlite3"))});
    assert.throws(() => importMarkdown(db, ${JSON.stringify(dir)}, ${JSON.stringify(dir)}, 'input.md',
      { harness: 'test', session: null }), /regular file/);
    db.close();
  `], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.error, undefined, "named-pipe import must not hang");
  assert.equal(result.status, 0, result.stderr);
});
