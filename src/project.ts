import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export function projectScope(cwd: string): string {
  const directory = realpathSync(cwd);
  const env = { ...process.env };
  // A shell's Git overrides must not redirect the session's memory scope.
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES"]) {
    delete env[key];
  }
  try {
    const root = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      encoding: "utf8", timeout: 2000, env, stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\r?\n$/, "");
    const scope = realpathSync(root);
    if (!isInside(scope, directory)) throw new Error("Git root does not contain the current directory");
    return scope;
  } catch (error) {
    // Do not silently create a different bucket when a known repository is broken.
    for (let dir = directory; ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) {
        throw new Error(`Cannot determine Git project root for ${JSON.stringify(directory)}`, { cause: error });
      }
      if (dirname(dir) === dir) break;
    }
    return directory;
  }
}

export function isInside(scope: string, file: string): boolean {
  const path = relative(scope, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
