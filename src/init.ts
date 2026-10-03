import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { memoryConfig } from "./config.ts";
import type { MemoryLimits } from "./limits.ts";
import { MemoryStore } from "./store.ts";

export interface InitializationPlan {
  previousPath: string;
  path: string;
  configPath: string;
  configText: string | null;
  limits: Readonly<MemoryLimits>;
}

function checkOverride(env: NodeJS.ProcessEnv): void {
  if (env.PI_MEMORY_DB !== undefined) throw new Error("/pi-mem init cannot select a database while PI_MEMORY_DB is set. Unset it and restart Pi, or restart with a fresh PI_MEMORY_DB path");
}

function configText(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) throw new Error("/pi-mem init requires a regular pi-mem.json file; directories and symlinks are not replaced");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function checkFresh(path: string): void {
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try { lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`Fresh database destination already exists: ${JSON.stringify(file)}; choose a new path`);
  }
}

/** Plan without opening the old database or writing files, so unavailable memory can recover. */
export function planInitialization(configDir: string, cwd: string, destination = "", env: NodeJS.ProcessEnv = process.env, home = homedir()): InitializationPlan {
  checkOverride(env);
  const configPath = join(configDir, "pi-mem.json");
  const original = configText(configPath);
  const { databasePath: previousPath, ...limits } = memoryConfig(configDir, env, home);
  if (configText(configPath) !== original) throw new Error("Memory configuration changed; run /pi-mem init again");
  const input = destination.trim();
  if (input.includes("\0") || input === ":memory:" || input.startsWith("--")) throw new Error("Usage: /pi-mem init [new-file-path]");
  const expanded = input === "~" ? home : input.startsWith("~/") ? join(home, input.slice(2)) : input;
  const path = input ? resolve(cwd, expanded)
    : join(dirname(previousPath), `${basename(previousPath, extname(previousPath))}-${randomUUID()}.sqlite3`);
  if (path === configPath) throw new Error("The database destination cannot be pi-mem.json");
  checkFresh(path);
  return { previousPath, path, configPath, configText: original, limits };
}

/** Reserve a new database exclusively and atomically select it; never remove database files. */
export function initializeDatabase(plan: InitializationPlan, env: NodeJS.ProcessEnv = process.env): void {
  checkOverride(env);
  const lock = `${plan.configPath}.init.lock`;
  mkdirSync(dirname(plan.configPath), { recursive: true, mode: 0o700 });
  let lockFd: number;
  try { lockFd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Database initialization is locked: ${JSON.stringify(lock)}. Retry when it finishes; remove a stale lock only when no initialization is running`);
    throw error;
  }
  const temporary = `${plan.configPath}.${randomUUID()}.tmp`;
  let created = false;
  let temporaryCreated = false;
  try {
    const checkConfig = () => {
      if (configText(plan.configPath) !== plan.configText) throw new Error("Memory configuration changed; run /pi-mem init again");
    };
    checkConfig();
    checkFresh(plan.path);
    mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 });
    const databaseFd = openSync(plan.path, "wx", 0o600);
    created = true;
    closeSync(databaseFd);
    const store = new MemoryStore(plan.path, plan.limits);
    store.close();
    const config = JSON.parse(plan.configText ?? "{}");
    const fd = openSync(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      writeFileSync(fd, JSON.stringify({ ...config, databasePath: plan.path }, null, 2) + "\n");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    checkConfig();
    renameSync(temporary, plan.configPath);
    temporaryCreated = false;
  } catch (error) {
    if (created) throw new Error(`New database file retained at ${JSON.stringify(plan.path)}, but not selected. ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    try { if (temporaryCreated) unlinkSync(temporary); }
    finally { closeSync(lockFd); unlinkSync(lock); }
  }
}
