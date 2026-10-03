import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { visible } from "./presentation.ts";

const APPLICATION_ID = 0x504d424b; // PMBK; separate from the lesson database.
export const BACKUP_FREQUENCIES = ["off", "daily", "weekly", "monthly"] as const;
export type BackupFrequency = typeof BACKUP_FREQUENCIES[number];
export interface BackupSettings { frequency: BackupFrequency; folder: string }
export interface BackupInfo { path: string; at: number; size: number; active: number; archived: number }
export interface BackupStats extends BackupSettings { last: BackupInfo | null; lastExists: boolean; files: number; bytes: number }

/** Calendar periods in local time; weeks start on Monday. */
export function backupPeriod(frequency: Exclude<BackupFrequency, "off">, at: number): string {
  const date = new Date(at);
  if (frequency === "weekly") date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), ...(frequency === "monthly" ? [] : [String(date.getDate()).padStart(2, "0")])].join("-");
}

/** Settings and admission locking live outside the lesson database: no lesson schema changes. */
export class Backups {
  readonly database: string;
  readonly statePath: string;
  private readonly prefix: string;
  constructor(database: string) {
    this.database = realpathSync(database);
    this.statePath = `${this.database}.backups.sqlite3`;
    this.prefix = `pi-mem-${createHash("sha256").update(this.database).digest("hex").slice(0, 12)}-`;
  }

  private defaults(): BackupSettings {
    return { frequency: "off", folder: join(dirname(this.database), `${basename(this.database)}.backups`) };
  }

  private connection(write: boolean): DatabaseSync | undefined {
    if (!write) {
      try { lstatSync(this.statePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    } else {
      try { closeSync(openSync(this.statePath, "wx", 0o600)); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const db = new DatabaseSync(this.statePath, { readOnly: !write });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const application = Number(db.prepare("PRAGMA application_id").get()!.application_id);
      const version = Number(db.prepare("PRAGMA user_version").get()!.user_version);
      const empty = application === 0 && version === 0 && !db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get();
      if (!empty && (application !== APPLICATION_ID || version !== 1)) throw new Error("Not a supported pi-mem backup settings database");
      if (write && empty) db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), frequency TEXT NOT NULL, folder TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS destinations (folder TEXT PRIMARY KEY, info TEXT NOT NULL) WITHOUT ROWID;
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = 1;
        COMMIT;
      `);
      return db;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }

  private readSettings(db?: DatabaseSync): BackupSettings {
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'settings'").get()) return this.defaults();
    const row = db.prepare("SELECT frequency, folder FROM settings WHERE id = 1").get();
    if (!row) return this.defaults();
    if (!BACKUP_FREQUENCIES.includes(row.frequency as BackupFrequency) || typeof row.folder !== "string" || !isAbsolute(row.folder) || /[\u0000-\u001f\u007f-\u009f]/u.test(row.folder)) {
      throw new Error("Invalid backup settings");
    }
    return { frequency: row.frequency as BackupFrequency, folder: row.folder };
  }

  settings(): BackupSettings {
    const db = this.connection(false);
    try { return this.readSettings(db); } finally { db?.close(); }
  }

  configure(change: Partial<BackupSettings>): BackupSettings {
    if (change.frequency !== undefined && !BACKUP_FREQUENCIES.includes(change.frequency)) throw new Error("Invalid backup frequency");
    let folder = change.folder;
    if (folder !== undefined) {
      folder = realpathSync(folder);
      if (!statSync(folder).isDirectory()) throw new Error("Backup folder must be an existing directory");
    }
    const db = this.connection(true)!;
    try {
      db.exec("BEGIN IMMEDIATE");
      const settings = { ...this.readSettings(db), ...change, ...(folder === undefined ? {} : { folder }) };
      db.prepare("INSERT INTO settings VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET frequency = excluded.frequency, folder = excluded.folder")
        .run(settings.frequency, settings.folder);
      db.exec("COMMIT");
      return settings;
    } finally {
      try { if (db.isTransaction) db.exec("ROLLBACK"); } finally { db.close(); }
    }
  }

  private last(db: DatabaseSync | undefined, folder: string): BackupInfo | null {
    const row = db?.prepare("SELECT 1 FROM sqlite_master WHERE name = 'destinations'").get()
      ? db.prepare("SELECT info FROM destinations WHERE folder = ?").get(folder) : undefined;
    return row ? JSON.parse(String(row.info)) as BackupInfo : null;
  }

  /** Read-only status never acquires the backup admission lock. Folder bytes exclude symlinks. */
  stats(): BackupStats {
    const db = this.connection(false);
    let settings: BackupSettings;
    let last: BackupInfo | null;
    try { settings = this.readSettings(db); last = this.last(db, settings.folder); } finally { db?.close(); }
    let files = 0;
    let bytes = 0;
    const walk = (folder: string) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        const stat = lstatSync(path);
        if (stat.isDirectory()) walk(path);
        else if (stat.isFile()) {
          bytes += stat.size;
          if (/^pi-mem-[0-9a-f]{12}-.*\.sqlite3$/.test(entry.name)) files++;
        }
      }
    };
    try { walk(settings.folder); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let lastExists = false;
    if (last) {
      try { lastExists = lstatSync(last.path).isFile(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { ...settings, last, lastExists, files, bytes };
  }

  /** The sidecar transaction serializes startup claims across processes and releases on crashes. */
  async create(automatic = false, at = Date.now()): Promise<BackupInfo | undefined> {
    if (automatic && this.settings().frequency === "off") return;
    const db = this.connection(true)!;
    let staging: string | undefined;
    try {
      if (automatic) db.exec("PRAGMA busy_timeout = 0");
      try { db.exec("BEGIN IMMEDIATE"); } catch (error) {
        if (automatic && (error as { errcode?: number }).errcode === 5) return;
        throw error;
      }
      const settings = this.readSettings(db);
      const last = this.last(db, settings.folder);
      if (automatic && (settings.frequency === "off" || (last &&
          backupPeriod(settings.frequency, last.at) >= backupPeriod(settings.frequency, at)))) return;
      mkdirSync(settings.folder, { recursive: true, mode: 0o700 });
      staging = mkdtempSync(join(settings.folder, ".pi-mem-backup-"));
      const temporary = join(staging, "snapshot.sqlite3");
      closeSync(openSync(temporary, "wx", 0o600));
      const source = new DatabaseSync(this.database, { readOnly: true });
      try { await backup(source, temporary); } finally { source.close(); }
      const snapshot = new DatabaseSync(temporary, { readOnly: true });
      let counts: { active: number; archived: number };
      try {
        if (snapshot.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) throw new Error("Backup integrity check failed");
        const row = snapshot.prepare("SELECT coalesce(sum(archived = 0), 0) AS active, coalesce(sum(archived = 1), 0) AS archived FROM lessons").get()!;
        counts = { active: Number(row.active), archived: Number(row.archived) };
      } finally { snapshot.close(); }
      const path = join(settings.folder, `${this.prefix}${new Date(at).toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.sqlite3`);
      // Publish only a complete snapshot, atomically and without replacing an existing file.
      linkSync(temporary, path);
      const info = { path, at, size: statSync(path).size, ...counts };
      db.prepare("INSERT INTO destinations VALUES (?, ?) ON CONFLICT(folder) DO UPDATE SET info = excluded.info")
        .run(settings.folder, JSON.stringify(info));
      db.exec("COMMIT");
      return info;
    } finally {
      try { if (db.isTransaction) db.exec("ROLLBACK"); } finally {
        db.close();
        if (staging) rmSync(staging, { recursive: true, force: true });
      }
    }
  }
}

export function backupFolder(cwd: string, entered: string): string {
  let value = entered.trim();
  if (!value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error("Enter a backup folder path without control characters");
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
  return resolve(cwd, value);
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
  return `${unit ? bytes.toFixed(1) : bytes} ${units[unit]}`;
}

export function backupReport(info: BackupInfo, total?: number): string {
  return `Memory backup created: ${visible(info.path)}\n${formatBytes(info.size)} · ${info.active + info.archived} lesson${info.active + info.archived === 1 ? "" : "s"} (${info.active} active, ${info.archived} archived)\nBackup folder total: ${total === undefined ? "unavailable" : formatBytes(total)}`;
}

export function backupStatsText(stats: BackupStats): string {
  return [
    `Auto backup: ${stats.frequency}`, `Folder: ${visible(stats.folder)}`,
    `Backup files in folder: ${stats.files} · Total folder size: ${formatBytes(stats.bytes)}`,
    ...(stats.last ? [`Last successful backup: ${new Date(stats.last.at).toLocaleString()}`, `File: ${visible(stats.last.path)}${stats.lastExists ? "" : " (missing)"}`,
      `Size when created: ${formatBytes(stats.last.size)}`, `Lessons: ${stats.last.active + stats.last.archived} (${stats.last.active} active, ${stats.last.archived} archived)`] : ["Last successful backup: never in this folder"]),
    "All projects, global lessons, and retained history. No automatic deletion.",
  ].join("\n");
}
