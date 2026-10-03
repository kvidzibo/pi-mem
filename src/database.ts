import { closeSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { APPLICATION_ID, SCHEMA_VERSION } from "./store.ts";

/** The configuration names a database family; schema upgrades never move a live file. */
export function schemaDatabasePath(base: string): string {
  const extension = extname(base);
  const stem = basename(base, extension).replace(/-v\d+$/, "");
  return join(dirname(base), `${stem}-v${SCHEMA_VERSION}${extension}`);
}

function unsupported(path: string, application?: number, version?: number): Error {
  return new Error(`Not a supported pi-mem database at ${JSON.stringify(path)}${application === undefined ? "" : ` (application=${application}, schema=${version})`}; choose another databasePath / PI_MEMORY_DB base filename`);
}

/** Read the header without opening old schemas in SQLite or touching their sidecars. */
function schema(path: string): number | undefined {
  let fd: number;
  try { fd = openSync(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const header = Buffer.alloc(100);
  let bytes: number;
  try { bytes = readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  if (bytes === 0) return 0;
  if (bytes !== header.length || header.subarray(0, 16).toString() !== "SQLite format 3\0") throw unsupported(path);
  let application = header.readUInt32BE(68);
  let version = header.readUInt32BE(60);
  if (application === 0 && version === 0) {
    // A live first-time WAL store may not have checkpointed its schema into page one yet.
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      application = Number(db.prepare("PRAGMA application_id").get()!.application_id);
      version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      if (application === 0 && version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0) return 0;
    } finally { db.close(); }
  }
  if (application !== APPLICATION_ID || version < 1) throw unsupported(path, application, version);
  return version;
}

export function selectDatabasePath(base: string): string {
  const path = schemaDatabasePath(base);
  // A versioned target remains authoritative once present; reopening must never switch stores.
  let exists = false;
  try { lstatSync(path); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (exists) {
    const version = schema(path);
    if (version === undefined || (version !== 0 && version !== SCHEMA_VERSION)) throw unsupported(path, APPLICATION_ID, version);
    return path;
  }
  // Preserve working unversioned installations when no versioned target has been selected yet.
  if (base !== path && schema(base) === SCHEMA_VERSION) return base;
  for (const sidecar of [`${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try { lstatSync(sidecar); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    // Another initializer may have created the file after the first existence check.
    try { lstatSync(path); return path; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    throw new Error(`Orphan SQLite sidecar at ${JSON.stringify(sidecar)}; preserve it and choose another database base filename`);
  }
  return path;
}

export function databaseCreatedNotice(base: string, path: string): string {
  const extension = extname(path);
  const stem = basename(path, extension).replace(/-v\d+$/, "");
  const previous = new Set<string>();
  for (const legacy of new Set([base, join(dirname(path), `${stem}${extension}`)])) {
    if (legacy === path) continue;
    try { lstatSync(legacy); previous.add(legacy); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const name of readdirSync(dirname(path)).sort()) {
    if (!name.startsWith(`${stem}-v`) || !name.endsWith(extension)) continue;
    const digits = name.slice(stem.length + 2, extension ? -extension.length : undefined);
    if (!/^\d+$/.test(digits) || Number(digits) >= SCHEMA_VERSION) continue;
    const old = join(dirname(path), name);
    if (old === path) continue;
    const info = lstatSync(old);
    if (info.isFile() || info.isSymbolicLink()) previous.add(old);
  }
  return [`Created memory database: ${JSON.stringify(path)}. Now using schema ${SCHEMA_VERSION}.`,
    ...(previous.size ? [`Previous databases left untouched: ${[...previous].map((old) => JSON.stringify(old)).join(", ")}.`,
      "Memories were not imported. To retain older memories, migrate them manually; there is no automatic migration."] : []),
  ].join("\n");
}
