import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { moveDestination, projectScope } from "../src/project.ts";
import { MemoryStore } from "../src/store.ts";

test("Git worktrees, subdirectories and symlinks share a scope; clones and non-Git cwds remain separate", (t) => {
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
  assert.equal(projectScope(worktree), root);
  mkdirSync(join(worktree, "nested"));
  assert.equal(projectScope(join(worktree, "nested")), root);
  symlinkSync(worktree, join(dir, "worktree-alias"));
  assert.equal(projectScope(join(dir, "worktree-alias")), root);
  const clone = join(dir, "clone");
  execFileSync("git", ["clone", "--quiet", root, clone]);
  assert.equal(projectScope(clone), clone);
  assert.equal(moveDestination(root, worktree).scope, root);
  const store = new MemoryStore(join(dir, "memory.sqlite"));
  try {
    const origin = { harness: "test", session: null };
    const lesson = store.add(projectScope(worktree), {
      text: "Share lessons across repository worktrees.", evidence: "Verified with linked worktree fixture.", basis: "user_request",
    }, origin).lesson;
    assert.equal(store.get(projectScope(root), lesson.id).id, lesson.id);
    assert.throws(() => store.get(projectScope(clone), lesson.id), /Lesson not found/);
    store.archive(projectScope(root), lesson.id, origin);
    assert.equal(store.get(projectScope(worktree), lesson.id).archived, true);
  } finally {
    store.close();
  }
  // Git reports the metadata directory as the main path for separate Git dirs.
  const separate = join(dir, "separate\ncheckout");
  const metadata = join(dir, "meta\ndata");
  execFileSync("git", ["init", "--quiet", "--separate-git-dir", metadata, separate]);
  execFileSync("git", ["-C", separate, "-c", "user.name=Memory Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const separateLinked = join(dir, "separate-linked");
  execFileSync("git", ["-C", separate, "worktree", "add", "--quiet", "--detach", separateLinked]);
  assert.equal(projectScope(separate), metadata);
  assert.equal(projectScope(separateLinked), metadata);
  mkdirSync(join(dir, "plain", "child"), { recursive: true });
  assert.equal(projectScope(join(dir, "plain")), join(dir, "plain"));
  assert.equal(projectScope(join(dir, "plain", "child")), join(dir, "plain", "child"));
  execFileSync("git", ["-C", root, "config", "core.worktree", worktree]);
  assert.throws(() => projectScope(root), /Cannot determine Git project root/, "Git config must not redirect recall to a sibling project");
});
