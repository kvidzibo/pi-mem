import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const MAX_TEXT = 1200;
export const MAX_EVIDENCE = 600;
export type Basis = "validated_fix" | "user_request" | "import";
export type State = "active" | "archived" | "all";
export interface Origin { harness: string; session: string | null }
export interface Lesson {
  id: string;
  scope: string;
  text: string;
  evidence: string;
  basis: Basis;
  source_harness: string;
  source_session: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
  archived: boolean;
}
export interface NewLesson { text: string; evidence: string; basis: Basis }
export interface Page { lessons: Lesson[]; total: number; nextOffset: number | null }

const APPLICATION_ID = 0x504d454d; // PMEM
const SCHEMA_VERSION = 1;

export function checkedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${name} must contain 1–${max} characters`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${name} contains control characters`);
  }
  return value.trim();
}

function textKey(text: string): string {
  return createHash("sha256").update(text.normalize("NFKC").replace(/\s+/gu, " ").trim()).digest("hex");
}

function checkNew(input: NewLesson): NewLesson {
  if (!["validated_fix", "user_request", "import"].includes(input.basis)) throw new Error("Invalid lesson basis");
  return {
    text: checkedText(input.text, "text", MAX_TEXT),
    evidence: checkedText(input.evidence, "evidence", MAX_EVIDENCE),
    basis: input.basis,
  };
}

function lesson(row: Record<string, unknown>): Lesson {
  const { text_key: _key, ...data } = row;
  return { ...data, archived: row.archived === 1 } as unknown as Lesson;
}

/** Harness-neutral SQLite storage. Every read/write is restricted to an exact scope. */
export class MemoryStore {
  private db: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Memory database path must be absolute");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      closeSync(openSync(path, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;");
      this.transaction(() => {
        const application = Number(this.db.prepare("PRAGMA application_id").get()!.application_id);
        const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
        if (application === 0 && version === 0 && tables.length === 0) {
          this.db.exec(`
            CREATE TABLE lessons (
              id TEXT PRIMARY KEY,
              scope TEXT NOT NULL,
              text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND ${MAX_TEXT}),
              text_key TEXT NOT NULL,
              evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND ${MAX_EVIDENCE}),
              basis TEXT NOT NULL CHECK(basis IN ('validated_fix', 'user_request', 'import')),
              source_harness TEXT NOT NULL,
              source_session TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              revision INTEGER NOT NULL DEFAULT 1,
              archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
              UNIQUE(scope, text_key)
            );
            CREATE INDEX lessons_recall ON lessons(scope, archived, updated_at DESC, id);
            PRAGMA application_id = ${APPLICATION_ID};
            PRAGMA user_version = ${SCHEMA_VERSION};
          `);
        } else if (application !== APPLICATION_ID || version !== SCHEMA_VERSION) {
          throw new Error(`Not a supported pi-mem database (application=${application}, schema=${version})`);
        }
      });
      const mode = this.db.prepare("PRAGMA journal_mode = WAL").get()!.journal_mode;
      if (mode !== "wal") throw new Error("Memory database requires SQLite WAL support on a local filesystem");
      this.db.exec("PRAGMA synchronous = FULL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private checkScope(scope: string): void {
    if (!isAbsolute(scope) || scope.includes("\0")) throw new Error("Memory scope must be an absolute project path");
  }

  private checkOrigin(origin: Origin): void {
    checkedText(origin.harness, "source harness", 80);
    if (origin.session !== null) checkedText(origin.session, "source session", 160);
  }

  get(scope: string, id: string): Lesson {
    this.checkScope(scope);
    const row = this.db.prepare("SELECT * FROM lessons WHERE scope = ? AND id = ?").get(scope, id);
    if (!row) throw new Error("Lesson not found in this project");
    return lesson(row);
  }

  list(scope: string, options: { query?: string; state?: State; offset?: number; limit?: number } = {}): Page {
    this.checkScope(scope);
    const { state = "active", offset = 0, limit = 30 } = options;
    if (!["active", "archived", "all"].includes(state)) throw new Error("Invalid lesson state");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error("offset must be nonnegative; limit must be between 1 and 30");
    }
    const query = options.query === undefined ? "" : checkedText(options.query, "query", 200);
    const where = `scope = ? AND (? = 'all' OR archived = ?) AND instr(lower(text || char(10) || evidence), lower(?)) > 0`;
    const params = [scope, state, state === "archived" ? 1 : 0, query];
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM lessons WHERE ${where}`).get(...params)!.n);
    const lessons = this.db.prepare(`SELECT * FROM lessons WHERE ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(lesson);
    const next = offset + lessons.length;
    return { lessons, total, nextOffset: next < total ? next : null };
  }

  activeTexts(scope: string): string[] {
    this.checkScope(scope);
    // A single SELECT is a consistent snapshot even while other sessions write.
    return this.db.prepare("SELECT text FROM lessons WHERE scope = ? AND archived = 0 ORDER BY updated_at DESC, id")
      .all(scope).map((row) => String(row.text));
  }

  add(scope: string, input: NewLesson, origin: Origin): { lesson: Lesson; created: boolean } {
    return this.addMany(scope, [input], origin)[0];
  }

  /** Atomic import; invalid input or a failed insert leaves the whole batch unchanged. */
  addMany(scope: string, inputs: NewLesson[], origin: Origin): Array<{ lesson: Lesson; created: boolean }> {
    this.checkScope(scope);
    this.checkOrigin(origin);
    if (inputs.length < 1 || inputs.length > 500) throw new Error("A batch must contain 1–500 lessons");
    const checked = inputs.map(checkNew);
    return this.transaction(() => checked.map((input) => {
      const key = textKey(input.text);
      const existing = this.db.prepare("SELECT * FROM lessons WHERE scope = ? AND text_key = ?").get(scope, key);
      if (existing) return { lesson: lesson(existing), created: false };
      const id = randomUUID();
      const now = Date.now();
      this.db.prepare(`INSERT INTO lessons
        (id, scope, text, text_key, evidence, basis, source_harness, source_session, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, scope, input.text, key, input.evidence, input.basis, origin.harness, origin.session, now, now,
      );
      return { lesson: this.get(scope, id), created: true };
    }));
  }

  update(scope: string, id: string, revision: number, input: NewLesson, origin: Origin): Lesson {
    const checked = checkNew(input);
    this.checkOrigin(origin);
    return this.transaction(() => {
      const current = this.checkRevision(scope, id, revision);
      const duplicate = this.db.prepare("SELECT id FROM lessons WHERE scope = ? AND text_key = ? AND id != ?")
        .get(scope, textKey(checked.text), id);
      if (duplicate) throw new Error(`Duplicate lesson already exists: ${duplicate.id}`);
      this.db.prepare(`UPDATE lessons SET text = ?, text_key = ?, evidence = ?, basis = ?,
        source_harness = ?, source_session = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND scope = ?`).run(
        checked.text, textKey(checked.text), checked.evidence, checked.basis, origin.harness, origin.session,
        Math.max(Date.now(), current.updated_at + 1), id, scope,
      );
      return this.get(scope, id);
    });
  }

  setArchived(scope: string, id: string, revision: number, archived: boolean): Lesson {
    return this.transaction(() => {
      const current = this.checkRevision(scope, id, revision);
      if (current.archived === archived) return current;
      this.db.prepare("UPDATE lessons SET archived = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND scope = ?")
        .run(archived ? 1 : 0, Math.max(Date.now(), current.updated_at + 1), id, scope);
      return this.get(scope, id);
    });
  }

  private checkRevision(scope: string, id: string, revision: number): Lesson {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("A positive revision is required");
    const current = this.get(scope, id);
    if (current.revision !== revision) throw new Error("Lesson changed in another session; get it again before editing");
    return current;
  }
}
