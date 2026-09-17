import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectScope } from "../src/project.ts";

test("Git subdirectories and symlinks share a scope; worktrees and non-Git cwds remain separate", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mem-project-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Memory Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const worktree = join(dir, "worktree");
  execFileSync("git", ["-C", root, "worktree", "add", "--quiet", "--detach", worktree]);
  symlinkSync(root, join(dir, "alias"));
  assert.equal(projectScope(join(root, "src")), root);
  assert.equal(projectScope(join(dir, "alias", "src")), root);
  assert.equal(projectScope(worktree), worktree);
  mkdirSync(join(dir, "plain", "child"), { recursive: true });
  assert.equal(projectScope(join(dir, "plain")), join(dir, "plain"));
  assert.equal(projectScope(join(dir, "plain", "child")), join(dir, "plain", "child"));
  execFileSync("git", ["-C", root, "config", "core.worktree", worktree]);
  assert.throws(() => projectScope(root), /Cannot determine Git project root/, "Git config must not redirect recall to a sibling project");
});
