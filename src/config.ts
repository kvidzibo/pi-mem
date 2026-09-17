import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { memoryLimits, type MemoryLimits } from "./limits.ts";

/** Only the adapter chooses the config directory; project files cannot redirect storage. */
export function memoryConfig(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Readonly<MemoryLimits> & { databasePath: string } {
  let config: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(join(configDir, "pi-mem.json"), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("pi-mem.json must contain an object");
    }
    if (Object.keys(parsed).some((key) => !["databasePath", "maxLessonWords", "maxEvidenceWords", "maxRecallLessons"].includes(key))) {
      throw new Error("pi-mem.json only supports databasePath, maxLessonWords, maxEvidenceWords and maxRecallLessons");
    }
    config = parsed;
  } catch (error) {
    // Preserve the explicit DB override's recovery behavior; unusable config uses default limits.
    if (env.PI_MEMORY_DB === undefined && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const limits = memoryLimits(config);
  let value: unknown = env.PI_MEMORY_DB ?? config.databasePath;
  if (value === undefined) value = resolve(configDir, "memory.sqlite3");
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value === ":memory:") {
    throw new Error("databasePath / PI_MEMORY_DB must be a nonempty file path");
  }
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = join(home, value.slice(2));
  return { ...limits, databasePath: isAbsolute(value as string) ? value as string : resolve(configDir, value as string) };
}

export function databasePath(configDir: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return memoryConfig(configDir, env, home).databasePath;
}
