import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { GLOBAL_SCOPE, checkNew, checkedPriority, checkedText, type Lesson, type NewLesson, type Origin } from "./store.ts";
import type { MemoryLimits } from "./limits.ts";

export type CandidateSubmission = Pick<NewLesson, "text" | "evidence" | "basis">;
export interface CandidateObservation {
  id: number; wording: string; evidence: string; basis: NewLesson["basis"];
  origin: Origin; created_at: number; independenceKey: string; exposed: boolean;
}
export interface Candidate {
  id: number; project: string; text: string; evidence: string;
  basis: NewLesson["basis"]; created_at: number; observations: CandidateObservation[];
}
export interface CandidateGroup {
  candidateIds: number[]; text: string; evidence: string; priority: number;
  scope: "project" | "global"; reason: string; recommend: boolean;
}
export interface CandidateExposure { candidateId: number; textKey: string; independenceKey: string; observationHighwater: number; created_at: number }
export interface CandidateSnapshot {
  candidates: Candidate[]; evaluations: CandidateEvaluation[]; exposures: CandidateExposure[]; highwater: number; marker: number;
}
export interface Qualification { occurrences: number; projects: number; eligible: boolean; resolvedScope: "project" | "global" }
export interface CandidateEvaluation {
  id: number; recorded_at: number; highwater: number; evaluator: Origin;
  groups: Array<{ group: CandidateGroup; qualification: Qualification; approved: boolean; lessonId: number | null }>;
}
export interface CandidatePromotion { groupIndex: number; lessonId: number; created: boolean }

type Row = Record<string, unknown>;
const json = (value: unknown) => JSON.stringify(value);
const textHash = (text: string) => createHash("sha256").update(text.normalize("NFKC").replace(/\s+/gu, " ").trim()).digest("hex");
// Exact candidate identity deliberately preserves case and command spelling, just like active lessons.
const nextId = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT coalesce(max(id), 0) + 1 AS id FROM ${table}`).get()!.id);

/** An observation made before disclosure remains independent; later repetitions do not. */
export function observationExposed(snapshot: CandidateSnapshot, ids: number[], observation: CandidateObservation): boolean {
  const identities = new Set(snapshot.candidates.filter((candidate) => ids.includes(candidate.id)).map((candidate) => textHash(candidate.text)));
  return snapshot.exposures.some((exposure) => identities.has(exposure.textKey) &&
    exposure.independenceKey === observation.independenceKey && observation.id > exposure.observationHighwater);
}

/** Same connection as MemoryStore, so approvals, provenance and active lessons commit together. */
export class CandidateStore {
  private readonly db: DatabaseSync;
  private readonly limits: Readonly<MemoryLimits>;
  private readonly checkOrigin: (origin: Origin) => void;
  private readonly transaction: <T>(fn: () => T) => T;
  private readonly insert: (scope: string, input: NewLesson, origin: Origin, now: number) => Lesson;

  constructor(db: DatabaseSync, limits: Readonly<MemoryLimits>, checkOrigin: (origin: Origin) => void,
    transaction: <T>(fn: () => T) => T, insert: (scope: string, input: NewLesson, origin: Origin, now: number) => Lesson) {
    this.db = db; this.limits = limits; this.checkOrigin = checkOrigin; this.transaction = transaction; this.insert = insert;
  }

  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidate_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL) WITHOUT ROWID;
      INSERT OR IGNORE INTO candidate_state VALUES ('evaluation_highwater', 0), ('marker', 0);
      CREATE TABLE IF NOT EXISTS candidates (
        id INTEGER PRIMARY KEY CHECK(typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
        project TEXT NOT NULL,
        text TEXT NOT NULL, text_key TEXT NOT NULL, evidence TEXT NOT NULL,
        basis TEXT NOT NULL CHECK(basis IN ('validated_learning', 'validated_fix', 'user_request')),
        created_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'promoted')),
        lesson_id INTEGER REFERENCES lessons(id), CHECK((status = 'pending') = (lesson_id IS NULL))
      ) WITHOUT ROWID;
      CREATE UNIQUE INDEX IF NOT EXISTS candidate_pending_identity ON candidates(project, text_key) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS candidate_text_identity ON candidates(text_key, id);
      CREATE TABLE IF NOT EXISTS candidate_observations (
        id INTEGER PRIMARY KEY CHECK(typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
        candidate_id INTEGER NOT NULL REFERENCES candidates(id), wording TEXT NOT NULL, evidence TEXT NOT NULL,
        basis TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(json_valid(origin)), owner_key TEXT NOT NULL,
        created_at INTEGER NOT NULL, independence_key TEXT NOT NULL,
        UNIQUE(candidate_id, owner_key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candidate_exposures (
        candidate_id INTEGER NOT NULL REFERENCES candidates(id), independence_key TEXT NOT NULL,
        observation_highwater INTEGER NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(candidate_id, independence_key)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candidate_evaluations (
        id INTEGER PRIMARY KEY CHECK(typeof(id) = 'integer' AND id BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER}),
        recorded_at INTEGER NOT NULL, highwater INTEGER NOT NULL, evaluator TEXT NOT NULL CHECK(json_valid(evaluator))
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candidate_evaluation_groups (
        evaluation_id INTEGER NOT NULL REFERENCES candidate_evaluations(id), group_index INTEGER NOT NULL,
        text TEXT NOT NULL, evidence TEXT NOT NULL, priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 10),
        scope TEXT NOT NULL CHECK(scope IN ('project', 'global')), reason TEXT NOT NULL,
        recommend INTEGER NOT NULL CHECK(recommend IN (0, 1)), approved INTEGER NOT NULL CHECK(approved IN (0, 1)),
        qualification TEXT NOT NULL CHECK(json_valid(qualification)), lesson_id INTEGER REFERENCES lessons(id),
        PRIMARY KEY(evaluation_id, group_index)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS candidate_group_members (
        evaluation_id INTEGER NOT NULL, group_index INTEGER NOT NULL, candidate_id INTEGER NOT NULL REFERENCES candidates(id),
        PRIMARY KEY(evaluation_id, group_index, candidate_id),
        UNIQUE(evaluation_id, candidate_id),
        FOREIGN KEY(evaluation_id, group_index) REFERENCES candidate_evaluation_groups(evaluation_id, group_index)
      ) WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS candidates_immutable BEFORE UPDATE OF
        id, project, text, text_key, evidence, basis, created_at ON candidates
        BEGIN SELECT RAISE(ABORT, 'Candidate content is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS candidates_promotion_only BEFORE UPDATE OF status, lesson_id ON candidates
        WHEN OLD.status != 'pending' OR NEW.status != 'promoted' OR NEW.lesson_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'Only pending-to-promoted transitions are allowed'); END;
      CREATE TRIGGER IF NOT EXISTS candidates_no_delete BEFORE DELETE ON candidates
        BEGIN SELECT RAISE(ABORT, 'Candidates cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS candidates_no_replace BEFORE INSERT ON candidates
        WHEN EXISTS (SELECT 1 FROM candidates WHERE id = NEW.id) OR
          (NEW.status = 'pending' AND EXISTS (SELECT 1 FROM candidates WHERE project = NEW.project AND text_key = NEW.text_key AND status = 'pending'))
        BEGIN SELECT RAISE(ABORT, 'Candidates cannot be replaced'); END;
    `);
    const immutableTables = {
      candidate_observations: "id = NEW.id OR (candidate_id = NEW.candidate_id AND owner_key = NEW.owner_key)",
      candidate_exposures: "candidate_id = NEW.candidate_id AND independence_key = NEW.independence_key",
      candidate_evaluations: "id = NEW.id",
      candidate_evaluation_groups: "evaluation_id = NEW.evaluation_id AND group_index = NEW.group_index",
      candidate_group_members: "evaluation_id = NEW.evaluation_id AND candidate_id = NEW.candidate_id",
    };
    for (const [table, conflicts] of Object.entries(immutableTables)) this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_immutable BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Candidate provenance is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT, 'Candidate provenance cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
        WHEN EXISTS (SELECT 1 FROM ${table} WHERE ${conflicts})
        BEGIN SELECT RAISE(ABORT, 'Candidate provenance cannot be replaced'); END;
    `);
    this.db.exec("PRAGMA user_version = 8;");
  }

  stage(project: string, input: CandidateSubmission, origin: Origin, independenceKey: string): { accepted: true } {
    if (!isAbsolute(project) || project.includes("\0")) throw new Error("Project must be an absolute path");
    if ("priority" in input) throw new Error("Candidate submissions do not accept priority; evaluation assigns it");
    const checked = checkNew(input, this.limits);
    if (checked.basis === "import") throw new Error("Imports do not create agent candidates");
    this.checkOrigin(origin);
    checkedText(independenceKey, "independence key", 300);
    this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM candidates WHERE project = ? AND text_key = ? AND status = 'pending'")
        .get(project, textHash(checked.text));
      const id = existing ? Number(existing.id) : nextId(this.db, "candidates");
      const now = Date.now();
      if (!existing) this.db.prepare(`INSERT INTO candidates
        (id, project, text, text_key, evidence, basis, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, project, checked.text, textHash(checked.text), checked.evidence, checked.basis, now);
      const owner = json([origin.harness, origin.session ?? independenceKey]);
      if (this.db.prepare("SELECT 1 FROM candidate_observations WHERE candidate_id = ? AND owner_key = ?").get(id, owner)) return;
      this.db.prepare(`INSERT INTO candidate_observations
        (id, candidate_id, wording, evidence, basis, origin, owner_key, created_at, independence_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nextId(this.db, "candidate_observations"), id, checked.text, checked.evidence,
          checked.basis, json(origin), owner, now, independenceKey);
      // Entirely new candidates may arrive during review; additions to a reviewed candidate make its snapshot stale.
      if (existing) this.bumpMarker();
    });
    // Deliberately no IDs, counts, matches, or previous wording in submitting agents' acknowledgements.
    return { accepted: true };
  }

  own(project: string, session: string): Candidate[] {
    checkedText(session, "session", 160);
    return this.readCandidates(project, session);
  }

  private readCandidates(project?: string, session?: string): Candidate[] {
    const ownerFilter = session === undefined ? "" : `AND c.project = ? AND EXISTS (
      SELECT 1 FROM candidate_observations o WHERE o.candidate_id = c.id AND json_extract(o.origin, '$.session') = ?)`;
    const rows = this.db.prepare(`SELECT c.* FROM candidates c WHERE c.status = 'pending' ${ownerFilter} ORDER BY c.id`)
      .all(...(session === undefined ? [] : [project!, session]));
    return rows.map((row) => {
      const observations = this.db.prepare(`SELECT o.* FROM candidate_observations o WHERE o.candidate_id = ?
        ${session === undefined ? "" : "AND json_extract(o.origin, '$.session') = ?"} ORDER BY o.id`)
        .all(...(session === undefined ? [Number(row.id)] : [Number(row.id), session])).map((observation) => this.observation(observation));
      const own = session === undefined ? undefined : observations[0];
      return { id: Number(row.id), project: String(row.project),
        text: own?.wording ?? String(row.text), evidence: own?.evidence ?? String(row.evidence),
        basis: own?.basis ?? row.basis as NewLesson["basis"],
        created_at: own?.created_at ?? Number(row.created_at), observations };
    });
  }

  private observation(row: Row): CandidateObservation {
    const id = Number(row.id);
    const independenceKey = String(row.independence_key);
    const exposure = this.db.prepare(`SELECT min(e.observation_highwater) AS observation_highwater FROM candidate_exposures e
      JOIN candidates disclosed ON disclosed.id = e.candidate_id JOIN candidates current ON current.id = ?
      WHERE disclosed.text_key = current.text_key AND e.independence_key = ?`).get(Number(row.candidate_id), independenceKey);
    return { id, wording: String(row.wording), evidence: String(row.evidence),
      basis: row.basis as NewLesson["basis"], origin: JSON.parse(String(row.origin)), created_at: Number(row.created_at),
      independenceKey, exposed: exposure?.observation_highwater != null && id > Number(exposure.observation_highwater) };
  }

  counts(): { pending: number; sinceEvaluation: number } {
    const highwater = this.state("evaluation_highwater");
    const row = this.db.prepare(`SELECT count(*) AS pending, coalesce(sum(id > ?), 0) AS sinceEvaluation
      FROM candidates WHERE status = 'pending'`).get(highwater)!;
    return { pending: Number(row.pending), sinceEvaluation: Number(row.sinceEvaluation) };
  }

  snapshot(): CandidateSnapshot {
    // A single consistent snapshot, including exposure timestamps and previous grouping decisions.
    this.db.exec("BEGIN");
    try {
      const candidates = this.readCandidates();
      const exposures = this.db.prepare(`SELECT e.*, c.text_key FROM candidate_exposures e JOIN candidates c ON c.id = e.candidate_id
        WHERE EXISTS (SELECT 1 FROM candidates pending WHERE pending.status = 'pending' AND pending.text_key = c.text_key)
        ORDER BY e.candidate_id, e.independence_key`).all().map((row) => ({
        candidateId: Number(row.candidate_id), textKey: String(row.text_key), independenceKey: String(row.independence_key),
        observationHighwater: Number(row.observation_highwater), created_at: Number(row.created_at),
      }));
      const evaluations = this.db.prepare(`SELECT DISTINCT e.* FROM candidate_evaluations e
        JOIN candidate_group_members m ON m.evaluation_id = e.id JOIN candidates original ON original.id = m.candidate_id
        JOIN candidates pending ON pending.text_key = original.text_key WHERE pending.status = 'pending' ORDER BY e.id`).all().map((row): CandidateEvaluation => ({
          id: Number(row.id), recorded_at: Number(row.recorded_at), highwater: Number(row.highwater), evaluator: JSON.parse(String(row.evaluator)),
          groups: this.db.prepare(`SELECT g.* FROM candidate_evaluation_groups g WHERE g.evaluation_id = ? AND EXISTS (
            SELECT 1 FROM candidate_group_members m JOIN candidates original ON original.id = m.candidate_id
            JOIN candidates pending ON pending.text_key = original.text_key
            WHERE m.evaluation_id = g.evaluation_id AND m.group_index = g.group_index AND pending.status = 'pending') ORDER BY g.group_index`)
            .all(Number(row.id)).map((group) => ({ group: {
              candidateIds: this.db.prepare("SELECT candidate_id FROM candidate_group_members WHERE evaluation_id = ? AND group_index = ? ORDER BY candidate_id")
                .all(Number(row.id), Number(group.group_index)).map((member) => Number(member.candidate_id)),
              text: String(group.text), evidence: String(group.evidence), priority: Number(group.priority),
              scope: group.scope as CandidateGroup["scope"], reason: String(group.reason), recommend: group.recommend === 1,
            }, qualification: JSON.parse(String(group.qualification)), approved: group.approved === 1,
            lessonId: group.lesson_id === null ? null : Number(group.lesson_id) })),
        }));
      const result = { candidates, exposures, evaluations,
        highwater: Number(this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM candidates").get()!.id), marker: this.state("marker") };
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  expose(snapshot: CandidateSnapshot, key: string, beforeDisclosure?: (snapshot: CandidateSnapshot) => void): CandidateSnapshot {
    checkedText(key, "independence key", 300);
    return this.transaction(() => {
      this.validateFresh(snapshot);
      const watermark = Number(this.db.prepare("SELECT coalesce(max(id), 0) AS id FROM candidate_observations").get()!.id);
      const additions = snapshot.candidates.filter((candidate) => !this.db.prepare(
        "SELECT 1 FROM candidate_exposures WHERE candidate_id = ? AND independence_key = ?").get(candidate.id, key))
        .map((candidate) => ({ candidateId: candidate.id, textKey: textHash(candidate.text), independenceKey: key,
          observationHighwater: watermark, created_at: Date.now() }));
      // Preflight the exact final payload before recording disclosure. Failure leaves both exposures and marker untouched.
      const disclosed = { ...snapshot, exposures: [...snapshot.exposures, ...additions], marker: snapshot.marker + (additions.length ? 1 : 0) };
      beforeDisclosure?.(disclosed);
      for (const exposure of additions) this.db.prepare("INSERT INTO candidate_exposures VALUES (?, ?, ?, ?)")
        .run(exposure.candidateId, exposure.independenceKey, exposure.observationHighwater, exposure.created_at);
      if (additions.length) this.bumpMarker();
      // Keep the exact disclosed candidate set: unrelated concurrent additions remain new and unevaluated.
      return disclosed;
    });
  }

  qualify(snapshot: CandidateSnapshot, ids: number[], scope: "project" | "global"): Qualification {
    const candidates = snapshot.candidates.filter((candidate) => ids.includes(candidate.id));
    const observations = candidates.flatMap((candidate) => candidate.observations.map((observation) => ({ observation, project: candidate.project })))
      .sort((a, b) => a.observation.id - b.observation.id);
    const independent = new Map<string, string>();
    for (const { observation, project } of observations) {
      if (!observationExposed(snapshot, ids, observation) && !independent.has(observation.independenceKey)) independent.set(observation.independenceKey, project);
    }
    const occurrences = independent.size;
    const projects = new Set(independent.values()).size;
    const oneProject = new Set(candidates.map((candidate) => candidate.project)).size === 1;
    const eligible = scope === "project" ? oneProject && occurrences >= this.limits.projectMinOccurrences
      : occurrences >= this.limits.globalMinOccurrences && projects >= this.limits.globalMinProjects;
    return { occurrences, projects, eligible, resolvedScope: scope };
  }

  private validateFresh(snapshot: CandidateSnapshot): void {
    if (this.state("marker") !== snapshot.marker || json(this.readCandidates().filter((candidate) => candidate.id <= snapshot.highwater)) !== json(snapshot.candidates)) {
      throw new Error("Candidate snapshot is stale; run a new evaluation");
    }
  }

  complete(snapshot: CandidateSnapshot, evaluator: Origin, groups: CandidateGroup[], approved: number[]): CandidatePromotion[] {
    this.checkOrigin(evaluator);
    this.validateGroups(snapshot, groups);
    if (!Array.isArray(approved) || approved.some((index) => !Number.isInteger(index) || index < 0 || index >= groups.length) || new Set(approved).size !== approved.length) {
      throw new Error("Invalid approved group indices");
    }
    return this.transaction(() => {
      this.validateFresh(snapshot);
      const result: CandidatePromotion[] = [];
      const evaluationId = nextId(this.db, "candidate_evaluations");
      this.db.prepare("INSERT INTO candidate_evaluations VALUES (?, ?, ?, ?)").run(evaluationId, Date.now(), snapshot.highwater, json(evaluator));
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        const qualification = this.qualify(snapshot, group.candidateIds, group.scope);
        let lessonId: number | null = null;
        if (approved.includes(index)) {
          if (!qualification.eligible || !group.recommend) throw new Error("Candidate group does not meet configured qualification thresholds or recommendation");
          const scope = group.scope === "global" ? GLOBAL_SCOPE : snapshot.candidates.find((candidate) => group.candidateIds.includes(candidate.id))!.project;
          const existing = this.db.prepare("SELECT id FROM lessons WHERE scope = ? AND text_key = ? AND archived = 0").get(scope, textHash(group.text));
          const basis = snapshot.candidates.find((candidate) => group.candidateIds.includes(candidate.id))!.basis;
          lessonId = existing ? Number(existing.id) : this.insert(scope,
            { text: group.text, evidence: group.evidence, basis, priority: group.priority }, { ...evaluator, reason: group.reason }, Date.now()).id;
          for (const id of group.candidateIds) this.db.prepare("UPDATE candidates SET status = 'promoted', lesson_id = ? WHERE id = ? AND status = 'pending'").run(lessonId, id);
          result.push({ groupIndex: index, lessonId, created: !existing });
        }
        this.db.prepare(`INSERT INTO candidate_evaluation_groups
          (evaluation_id, group_index, text, evidence, priority, scope, reason, recommend, approved, qualification, lesson_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(evaluationId, index, group.text, group.evidence, group.priority, group.scope, group.reason,
            group.recommend ? 1 : 0, approved.includes(index) ? 1 : 0, json(qualification), lessonId);
        for (const id of group.candidateIds) this.db.prepare("INSERT INTO candidate_group_members VALUES (?, ?, ?)").run(evaluationId, index, id);
      }
      this.db.prepare("UPDATE candidate_state SET value = ? WHERE key = 'evaluation_highwater'").run(snapshot.highwater);
      this.bumpMarker();
      return result;
    });
  }

  private validateGroups(snapshot: CandidateSnapshot, groups: CandidateGroup[]): void {
    if (!Array.isArray(groups) || groups.length > 10000) throw new Error("Groups must be a bounded array");
    const known = new Map(snapshot.candidates.map((candidate) => [candidate.id, candidate]));
    const seen = new Set<number>();
    for (const group of groups) {
      if (!group || Object.keys(group).sort().join(",") !== "candidateIds,evidence,priority,reason,recommend,scope,text") throw new Error("Invalid group fields");
      if (!Array.isArray(group.candidateIds) || !group.candidateIds.length || group.candidateIds.length > 10000) throw new Error("Invalid candidate IDs");
      for (const id of group.candidateIds) {
        if (!Number.isSafeInteger(id) || id <= 0 || !known.has(id) || seen.has(id)) throw new Error("Invalid or duplicate candidate IDs");
        seen.add(id);
      }
      if (group.scope !== "project" && group.scope !== "global") throw new Error("Invalid candidate group scope");
      if (group.scope === "project" && new Set(group.candidateIds.map((id) => known.get(id)!.project)).size !== 1) throw new Error("Project groups must belong to one project");
      if (typeof group.recommend !== "boolean") throw new Error("recommend must be boolean");
      checkedPriority(group.priority, 1);
      checkedText(group.reason, "reason", 600);
      checkNew({ text: group.text, evidence: group.evidence, priority: group.priority, basis: "validated_learning" }, this.limits);
    }
    if (seen.size !== known.size) throw new Error("Groups must partition snapshot candidates exactly once");
  }

  private state(key: string): number { return Number(this.db.prepare("SELECT value FROM candidate_state WHERE key = ?").get(key)!.value); }
  private bumpMarker(): void { this.db.prepare("UPDATE candidate_state SET value = value + 1 WHERE key = 'marker'").run(); }
}
