import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Only the adapter chooses the config directory; project files cannot redirect storage. */
export function databasePath(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  let value: unknown = env.PI_MEMORY_DB;
  if (value === undefined) {
    let contents: string | undefined;
    try {
      contents = readFileSync(join(configDir, "pi-mem.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (contents !== undefined) {
      const config = JSON.parse(contents);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error("pi-mem.json must contain an object");
      }
      if (Object.keys(config).some((key) => key !== "databasePath")) {
        throw new Error("pi-mem.json only supports databasePath");
      }
      value = config.databasePath;
    }
  }
  if (value === undefined) return resolve(configDir, "memory.sqlite3");
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value === ":memory:") {
    throw new Error("databasePath / PI_MEMORY_DB must be a nonempty file path");
  }
  if (value === "~") value = home;
  else if (value.startsWith("~/")) value = join(home, value.slice(2));
  return isAbsolute(value as string) ? value as string : resolve(configDir, value as string);
}
