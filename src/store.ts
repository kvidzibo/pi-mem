import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_LIMITS, memoryLimits, type MemoryLimits } from "./limits.ts";

export const MAX_TEXT = 1200;
export const MAX_EVIDENCE = 600;
// Keep historical import provenance readable without changing the retained database schema.
export type Basis = "validated_learning" | "validated_fix" | "user_request" | "import";
export type State = "active" | "archived" | "all";
export interface Origin { harness: string; session: string | null }
export interface Lesson {
  id: number;
  scope: string;
  text: string;
  priority: number;
  evidence: string;
  basis: Basis;
  source_harness: string;
  source_session: string | null;
  created_at: number;
  // Retained legacy metadata; new records never update these fields.
  updated_at: number;
  revision: number;
  archived: boolean;
  archived_at: number | null;
  supersedes_id: number | null;
}
export interface NewLesson { text: string; evidence: string; basis: Basis; priority?: number }
export interface RecallPage { lessons: Iterable<Lesson>; total: number }
export interface Page extends RecallPage { lessons: Lesson[]; nextOffset: number | null }

const APPLICATION_ID = 0x504d454d; // PMEM
const SCHEMA_VERSION = 6;
export const DEFAULT_PRIORITY = 5;

export function checkedPriority(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > 10) {
    throw new Error(`priority must be an integer from ${minimum} to 10`);
  }
  return value;
}
const LESSONS_IMMUTABLE_TRIGGER = `CREATE TRIGGER lessons_immutable BEFORE UPDATE OF
  id, scope, text, text_key, evidence, basis, source_harness, source_session,
  created_at, updated_at, revision, supersedes_id ON lessons
BEGIN SELECT RAISE(ABORT, 'Lesson content is immutable; supersede it instead'); END;`;

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

export function checkNew(input: NewLesson, limits: Readonly<MemoryLimits>): NewLesson {
  if (!["validated_learning", "validated_fix", "user_request", "import"].includes(input.basis)) throw new Error("Invalid lesson basis");
  const checked = {
    text: checkedText(input.text, "text", MAX_TEXT),
    evidence: checkedText(input.evidence, "evidence", MAX_EVIDENCE),
    basis: input.basis,
    ...(input.priority !== undefined ? { priority: checkedPriority(input.priority) } : {}),
  };
  for (const [field, max] of [["text", limits.maxLessonWords], ["evidence", limits.maxEvidenceWords]] as const) {
    const count = checked[field].split(/\s+/u).length;
    if (count > max) throw new Error(`${field} exceeds ${max} words (${count} whitespace-separated words); shorten and retry`);
  }
  return checked;
}

function lesson(row: Record<string, unknown>): Lesson {
  const { text_key: _key, ...data } = row;
  return { ...data, archived: row.archived === 1 } as unknown as Lesson;
}

/** Harness-neutral SQLite storage. Every read/write is restricted to an exact scope. */
export class MemoryStore {
  private db: DatabaseSync;
  private closed = false;
  private readonly limits: Readonly<MemoryLimits>;

  constructor(path: string, limits: Readonly<MemoryLimits> = DEFAULT_LIMITS) {
    this.limits = memoryLimits({ ...limits });
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
      this.transaction(() => this.initializeSchema());
      const mode = this.db.prepare("PRAGMA journal_mode = WAL").get()!.journal_mode;
      if (mode !== "wal") throw new Error("Memory database requires SQLite WAL support on a local filesystem");
      this.db.exec("PRAGMA synchronous = FULL;");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeSchema(): void {
    const application = Number(this.db.prepare("PRAGMA application_id").get()!.application_id);
    const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
    const empty = application === 0 && version === 0 &&
      this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length === 0;
    if (application === APPLICATION_ID && version === 5) {
      this.db.exec(`ALTER TABLE lessons ADD COLUMN priority INTEGER NOT NULL DEFAULT ${DEFAULT_PRIORITY}
        CHECK(typeof(priority) = 'integer' AND priority BETWEEN 0 AND 10);
        DROP INDEX lessons_recall;
        CREATE INDEX lessons_recall ON lessons(scope, archived, priority, created_at DESC, id);`);
      this.initializePriorityHistory();
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      return;
    }
    const upgrading = application === APPLICATION_ID && [1, 2, 3, 4].includes(version);
    if (!empty && !upgrading) {
      if (application !== APPLICATION_ID || version !== SCHEMA_VERSION) {
        throw new Error(`Not a supported pi-mem database (application=${application}, schema=${version})`);
      }
      return;
    }
    if (upgrading) {
      // Rebuild atomically; the old indexes/triggers otherwise retain their names after renaming.
      this.db.exec(`
        DROP INDEX IF EXISTS lessons_active_text;
        DROP INDEX IF EXISTS lessons_recall;
        DROP TRIGGER IF EXISTS lessons_immutable;
        DROP TRIGGER IF EXISTS lessons_archive_only;
        DROP TRIGGER IF EXISTS lessons_no_delete;
        DROP TRIGGER IF EXISTS lessons_no_replace;
        DROP TRIGGER IF EXISTS lessons_successor_scope;
        ALTER TABLE lessons RENAME TO lessons_previous;
      `);
      if (version >= 3 && this.db.prepare(`SELECT 1 FROM lessons_previous AS child
        WHERE supersedes_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM lessons_previous AS parent
          WHERE parent.id = child.supersedes_id AND parent.scope = child.scope AND parent.archived = 1)
        LIMIT 1`).get()) throw new Error("Cannot migrate invalid lesson predecessor links");
    }
    this.db.exec(`
      CREATE TABLE lessons (
        id INTEGER PRIMARY KEY CHECK(typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
        scope TEXT NOT NULL,
        text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND ${MAX_TEXT}),
        priority INTEGER NOT NULL DEFAULT ${DEFAULT_PRIORITY} CHECK(typeof(priority) = 'integer' AND priority BETWEEN 0 AND 10),
        text_key TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK(length(evidence) BETWEEN 1 AND ${MAX_EVIDENCE}),
        basis TEXT NOT NULL CHECK(basis IN ('validated_learning', 'validated_fix', 'user_request', 'import')),
        source_harness TEXT NOT NULL,
        source_session TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0, 1)),
        archived_at INTEGER CHECK(archived_at IS NULL OR (archived = 1 AND archived_at >= created_at)),
        supersedes_id INTEGER UNIQUE REFERENCES lessons(id)
      ) WITHOUT ROWID;
    `);
    // UUIDs exist only in this migration query; already-integer v4 IDs must not be renumbered.
    if (upgrading) this.db.exec(`
      WITH numbered AS (
        SELECT ${version === 4 ? "id" : "row_number() OVER (ORDER BY created_at, id)"} AS new_id, * FROM lessons_previous
      )
      INSERT INTO lessons
        (id, scope, text, text_key, evidence, basis, source_harness, source_session,
         created_at, updated_at, revision, archived, archived_at, supersedes_id)
      SELECT old.new_id, old.scope, old.text, old.text_key, old.evidence, old.basis,
        old.source_harness, old.source_session, old.created_at, old.updated_at, old.revision, old.archived,
        ${version >= 3 ? "old.archived_at, predecessor.new_id" : "NULL, NULL"}
      FROM numbered AS old
      ${version >= 3 ? "LEFT JOIN numbered AS predecessor ON predecessor.id = old.supersedes_id" : ""};
      DROP TABLE lessons_previous;
    `);
    // Preserve lesson metadata; v1/v2 archive dates remain unknown (NULL).
    this.db.exec(`
      CREATE UNIQUE INDEX lessons_active_text ON lessons(scope, text_key) WHERE archived = 0;
      CREATE INDEX lessons_recall ON lessons(scope, archived, priority, created_at DESC, id);
      ${LESSONS_IMMUTABLE_TRIGGER}
      CREATE TRIGGER lessons_archive_only BEFORE UPDATE OF archived, archived_at ON lessons
      WHEN OLD.archived != 0 OR NEW.archived != 1 OR NEW.archived_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'Only active-to-archived transitions are allowed'); END;
      CREATE TRIGGER lessons_no_delete BEFORE DELETE ON lessons
      BEGIN SELECT RAISE(ABORT, 'Lessons cannot be deleted'); END;
      -- WITHOUT ROWID removes hidden-key conflicts; guard every remaining REPLACE conflict explicitly.
      CREATE TRIGGER lessons_no_replace BEFORE INSERT ON lessons
      WHEN EXISTS (SELECT 1 FROM lessons WHERE id = NEW.id)
        OR (NEW.archived = 0 AND EXISTS (
          SELECT 1 FROM lessons WHERE scope = NEW.scope AND text_key = NEW.text_key AND archived = 0))
        OR (NEW.supersedes_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM lessons WHERE supersedes_id = NEW.supersedes_id))
      BEGIN SELECT RAISE(ABORT, 'Existing lessons cannot be replaced'); END;
      CREATE TRIGGER lessons_successor_scope BEFORE INSERT ON lessons
      WHEN NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM lessons WHERE id = NEW.supersedes_id AND scope = NEW.scope AND archived = 1)
      BEGIN SELECT RAISE(ABORT, 'Predecessor must be archived in the same project'); END;
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    this.initializePriorityHistory();
    if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid migrated lesson links");
  }

  private initializePriorityHistory(): void {
    this.db.exec(`
      CREATE TABLE priority_changes (
        id INTEGER PRIMARY KEY,
        lesson_id INTEGER NOT NULL REFERENCES lessons(id),
        old_priority INTEGER NOT NULL CHECK(old_priority BETWEEN 0 AND 10),
        new_priority INTEGER NOT NULL CHECK(new_priority BETWEEN 0 AND 10),
        changed_at INTEGER NOT NULL,
        source_harness TEXT NOT NULL,
        source_session TEXT
      ) WITHOUT ROWID;
      CREATE TRIGGER priority_changes_no_update BEFORE UPDATE ON priority_changes
        BEGIN SELECT RAISE(ABORT, 'Priority history is immutable'); END;
      CREATE TRIGGER priority_changes_no_delete BEFORE DELETE ON priority_changes
        BEGIN SELECT RAISE(ABORT, 'Priority history cannot be deleted'); END;
      CREATE TRIGGER priority_changes_no_replace BEFORE INSERT ON priority_changes
        WHEN EXISTS (SELECT 1 FROM priority_changes WHERE id = NEW.id)
        BEGIN SELECT RAISE(ABORT, 'Priority history cannot be replaced'); END;
      CREATE TRIGGER lessons_archived_priority BEFORE UPDATE OF priority ON lessons WHEN OLD.archived = 1
        BEGIN SELECT RAISE(ABORT, 'Archived lesson priority is read-only'); END;
    `);
  }

  /** Human-only metadata change; lesson identity and content stay untouched. */
  setPriority(scope: string, id: number, priority: number, origin: Origin): Lesson {
    checkedPriority(priority);
    this.checkOrigin(origin);
    return this.transaction(() => {
      const current = this.get(scope, id);
      if (current.archived) throw new Error("Archived lesson priority is read-only");
      if (current.priority === priority) return current;
      this.db.prepare(`INSERT INTO priority_changes
        (id, lesson_id, old_priority, new_priority, changed_at, source_harness, source_session)
        VALUES ((SELECT coalesce(max(id), 0) + 1 FROM priority_changes), ?, ?, ?, ?, ?, ?)`)
        .run(id, current.priority, priority, Date.now(), origin.harness, origin.session);
      this.db.prepare("UPDATE lessons SET priority = ? WHERE scope = ? AND id = ?").run(priority, scope, id);
      return this.get(scope, id);
    });
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

  listScopes(): string[] {
    return this.db.prepare("SELECT DISTINCT scope FROM lessons ORDER BY scope").all().map((row) => String(row.scope));
  }

  moveScope(from: string, to: string): number {
    this.checkScope(from);
    this.checkScope(to);
    if (from === to) throw new Error("Source and destination scopes must differ");
    return this.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM lessons WHERE scope = ? LIMIT 1").get(from)) {
        throw new Error("Source scope does not exist");
      }
      if (this.db.prepare("SELECT 1 FROM lessons WHERE scope = ? LIMIT 1").get(to)) {
        throw new Error("Destination scope is occupied");
      }
      const count = Number(this.db.prepare("SELECT count(*) AS n FROM lessons WHERE scope = ?").get(from)!.n);
      this.db.exec("DROP TRIGGER lessons_immutable");
      this.db.prepare("UPDATE lessons SET scope = ? WHERE scope = ?").run(to, from);
      this.db.exec(LESSONS_IMMUTABLE_TRIGGER);
      return count;
    });
  }

  moveLesson(from: string, id: number, to: string): number {
    this.checkScope(from);
    this.checkScope(to);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("id must be a positive safe integer");
    if (from === to) throw new Error("Source and destination scopes must differ");
    return this.transaction(() => {
      const selected = this.db.prepare("SELECT 1 FROM lessons WHERE scope = ? AND id = ?").get(from, id);
      if (!selected) throw new Error("Lesson not found in this project");
      // UNION deduplicates the bidirectional walk; no chain member can be left behind.
      const chain = `WITH RECURSIVE chain(id, supersedes_id) AS (
        SELECT id, supersedes_id FROM lessons WHERE scope = ? AND id = ?
        UNION
        SELECT l.id, l.supersedes_id FROM lessons l JOIN chain c
          ON l.id = c.supersedes_id OR l.supersedes_id = c.id
        WHERE l.scope = ?
      )`;
      const duplicate = this.db.prepare(`${chain}
        SELECT 1 FROM lessons l JOIN chain c ON c.id = l.id JOIN lessons d
          ON d.scope = ? AND d.archived = 0 AND l.archived = 0 AND d.text_key = l.text_key
        LIMIT 1`).get(from, id, from, to);
      if (duplicate) throw new Error("Duplicate active text in destination project");
      this.db.exec("DROP TRIGGER lessons_immutable");
      const result = this.db.prepare(`${chain}
        UPDATE lessons SET scope = ? WHERE scope = ? AND id IN (SELECT id FROM chain)`)
        .run(from, id, from, to, from);
      this.db.exec(LESSONS_IMMUTABLE_TRIGGER);
      return Number(result.changes);
    });
  }

  get(scope: string, id: number): Lesson {
    this.checkScope(scope);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("id must be a positive safe integer");
    const row = this.db.prepare("SELECT * FROM lessons WHERE scope = ? AND id = ?").get(scope, id);
    if (!row) throw new Error("Lesson not found in this project");
    return lesson(row);
  }

  list(scope: string, options: { query?: string; state?: State; offset?: number; limit?: number } = {}): Page {
    this.checkScope(scope);
    const { state = "active", offset = 0, limit = 30 } = options;
    if (!["active", "archived", "all"].includes(state)) throw new Error("Invalid lesson state");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("offset must be nonnegative; limit must be between 1 and 1000");
    }
    const query = options.query === undefined ? "" : checkedText(options.query, "query", 200);
    const where = `scope = ? AND (? = 'all' OR archived = ?) AND instr(lower(text || char(10) || evidence), lower(?)) > 0`;
    const params = [scope, state, state === "archived" ? 1 : 0, query];
    const total = Number(this.db.prepare(`SELECT count(*) AS n FROM lessons WHERE ${where}`).get(...params)!.n);
    const lessons = this.db.prepare(`SELECT * FROM lessons WHERE ${where} ORDER BY priority, created_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset).map(lesson);
    const next = offset + lessons.length;
    return { lessons, total, nextOffset: next < total ? next : null };
  }

  /** Creations and their linked predecessor archives remain attributable after reload. */
  sessionCreations(scope: string, origin: Origin): { added: number; superseded: number } {
    this.checkScope(scope);
    this.checkOrigin(origin);
    const row = this.db.prepare(`SELECT count(*) AS added, count(supersedes_id) AS superseded FROM lessons
      WHERE scope = ? AND source_harness = ? AND source_session = ?`)
      .get(scope, origin.harness, origin.session)!;
    return { added: Number(row.added), superseded: Number(row.superseded) };
  }

  recall(scope: string): RecallPage {
    this.checkScope(scope);
    const total = Number(this.db.prepare("SELECT count(*) AS n FROM lessons WHERE scope = ? AND archived = 0").get(scope)!.n);
    const db = this.db;
    const limit = this.limits.maxRecallLessons;
    return {
      total,
      // Stream one ordered query; breaking at the byte budget closes the cursor without reading every lesson.
      lessons: (function* () {
        const rows = db.prepare("SELECT * FROM lessons WHERE scope = ? AND archived = 0 ORDER BY priority, created_at DESC, id LIMIT ?")
          .iterate(scope, limit);
        for (const row of rows) yield lesson(row);
      })(),
    };
  }

  add(scope: string, input: NewLesson, origin: Origin): { lesson: Lesson; created: boolean } {
    return this.addMany(scope, [input], origin)[0];
  }

  /** Atomic batch; invalid input or a failed insert leaves the whole batch unchanged. */
  addMany(scope: string, inputs: NewLesson[], origin: Origin): Array<{ lesson: Lesson; created: boolean }> {
    this.checkScope(scope);
    this.checkOrigin(origin);
    if (inputs.length < 1 || inputs.length > 500) throw new Error("A batch must contain 1–500 lessons");
    const checked = inputs.map((input) => checkNew(input, this.limits));
    return this.transaction(() => checked.map((input) => {
      const existing = this.db.prepare("SELECT * FROM lessons WHERE scope = ? AND text_key = ? AND archived = 0")
        .get(scope, textKey(input.text));
      if (existing) return { lesson: lesson(existing), created: false };
      return { lesson: this.insert(scope, input, origin, Date.now()), created: true };
    }));
  }

  /** Create a successor and retire its predecessor together, retaining all original content and provenance. */
  supersede(scope: string, id: number, input: NewLesson, origin: Origin, preserveExtreme = false): Lesson {
    const checked = checkNew(input, this.limits);
    this.checkOrigin(origin);
    return this.transaction(() => {
      const current = this.get(scope, id);
      if (current.archived) throw new Error("Lesson is already archived; only an active lesson can be superseded");
      const duplicate = this.db.prepare("SELECT id FROM lessons WHERE scope = ? AND text_key = ? AND archived = 0 AND id != ?")
        .get(scope, textKey(checked.text), current.id);
      if (duplicate) throw new Error(`Duplicate active lesson already exists: ${duplicate.id}`);
      const now = Math.max(Date.now(), current.created_at + 1, current.updated_at);
      this.retire(scope, current.id, now);
      return this.insert(scope, { ...checked,
        priority: preserveExtreme && current.priority === 0 ? 0 : checked.priority ?? current.priority,
      }, origin, now, current.id);
    });
  }

  archive(scope: string, id: number): { lesson: Lesson; changed: boolean } {
    return this.transaction(() => {
      const current = this.get(scope, id);
      if (current.archived) return { lesson: current, changed: false };
      this.retire(scope, current.id, Math.max(Date.now(), current.created_at, current.updated_at));
      return { lesson: this.get(scope, current.id), changed: true };
    });
  }

  private retire(scope: string, id: number, now: number): void {
    this.db.prepare("UPDATE lessons SET archived = 1, archived_at = ? WHERE id = ? AND scope = ?")
      .run(now, id, scope);
  }

  private insert(scope: string, input: NewLesson, origin: Origin, now: number, supersedesId: number | null = null): Lesson {
    // All callers hold BEGIN IMMEDIATE; immutable retained rows make MAX + 1 safe and never reused.
    const id = Number(this.db.prepare("SELECT coalesce(max(id), 0) + 1 AS id FROM lessons").get()!.id);
    if (!Number.isSafeInteger(id)) throw new Error("Lesson ID range exhausted");
    this.db.prepare(`INSERT INTO lessons
      (id, scope, text, text_key, evidence, basis, source_harness, source_session, created_at, updated_at, supersedes_id, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, scope, input.text, textKey(input.text), input.evidence, input.basis, origin.harness, origin.session, now, now, supersedesId, input.priority ?? DEFAULT_PRIORITY,
    );
    return this.get(scope, id);
  }
}
