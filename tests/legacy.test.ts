import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { legacyContext, legacyFiles, LEGACY_CONTEXT_BYTES, LEGACY_READ_FILES, LEGACY_SCAN_ENTRIES } from "../src/legacy.ts";

test("legacy recall is cwd-only, case-insensitive, bounded, and rejects outside targets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-legacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  const child = join(project, "src");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(project, "Memory.md"), "Unstructured legacy text with a terminal escape: \x1b[2J\n");
  let result = legacyContext(project, project);
  assert.match(result.text, /Unstructured legacy/);
  assert.doesNotMatch(result.text, /\x1b/);
  assert.match(result.warning, /\/memory import Memory.md/);
  assert.equal(legacyContext(project, child).text, "", "do not inherit a parent's legacy file");
  writeFileSync(join(dir, "external.md"), "Must never be recalled.");
  symlinkSync(join(dir, "external.md"), join(project, "memory.md"));
  assert.deepEqual(legacyFiles(project), ["Memory.md", "memory.md"]);
  result = legacyContext(project, project);
  assert.doesNotMatch(result.text, /Must never be recalled/);
  assert.match(result.warning, /inside the current project/);
  writeFileSync(join(project, "Memory.md"), "Legacy line.\n".repeat(5000));
  result = legacyContext(project, project);
  assert.ok(Buffer.byteLength(result.text) <= LEGACY_CONTEXT_BYTES);
  assert.match(result.text, /Legacy context truncated/);
  assert.match(result.warning, /truncated at 32 KiB/);

  const bounded = join(dir, "bounded");
  mkdirSync(bounded);
  for (let variant = 0; variant <= LEGACY_READ_FILES; variant++) {
    let bit = 0;
    const name = "memory.md".replace(/[a-z]/g, (letter) => variant & (1 << bit++) ? letter.toUpperCase() : letter);
    writeFileSync(join(bounded, name), Buffer.alloc(1024 * 1024, 0xff)); // Unreadable UTF-8 must still consume a read slot.
  }
  result = legacyContext(bounded, bounded);
  assert.equal(result.text.match(/Legacy file not loaded/g)!.length, LEGACY_READ_FILES);
  assert.match(result.warning, /1 additional memory file\(s\) not read/);
  const busy = join(dir, "busy");
  mkdirSync(busy);
  for (let i = 0; i <= LEGACY_SCAN_ENTRIES; i++) writeFileSync(join(busy, `entry-${i}`), "");
  assert.match(legacyContext(busy, busy).warning, /Discovery stopped at 10000 directory entries/);
  assert.throws(() => legacyFiles(busy), /explicit-path/);
});
