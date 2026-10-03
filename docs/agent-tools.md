# Agent tools

pi-mem exposes **three tools**: `memory`, `memory_audit`, and `memory_evaluate`.
There are no agent read, search, history, restore, or delete tools.

The runtime JSON schemas, descriptions, argument preparation, and handlers are
registered with `pi.registerTool` in [`src/index.ts`](../src/index.ts). Supporting
request types and validators live in [`src/operations.ts`](../src/operations.ts),
[`src/audit.ts`](../src/audit.ts), and
[`src/evaluation.ts`](../src/evaluation.ts); candidate/evaluation data types live
in [`src/candidates.ts`](../src/candidates.ts). Those implementations are the
source of truth; this document describes their public contract.

`/pi-mem` commands and menus are **human interfaces, not agent tools**. Explicit
human additions still create active lessons immediately.

## Common rules

- Successful results contain JSON text in `content` and the same object in
  `details`. Invalid arguments or stale state produce Pi tool errors, not a
  successful result with an `error` status.
- All input objects reject extra fields. IDs are positive safe integers, at most
  `Number.MAX_SAFE_INTEGER`. Argument preparation also accepts decimal strings
  and `#42`-style lesson IDs; booleans and other coercible non-IDs are rejected.
- `text` is nonblank and at most **1,200 characters**; `evidence` is nonblank and
  at most **600 characters**. Both also obey configured word limits (default
  **20 words each**). A supplied `reason` is nonblank, at most **600 characters**.
  Forbidden control characters are rejected.
- No secrets or raw transcripts. Origins, timestamps, project roots, and
  discovery-lineage metadata are captured by the extension, not supplied by the
  submitting agent.

## `memory`

Ordinary lesson submission and maintenance of already-active lessons.
**There is no `scope` input.** A submission records a lesson, not a request to
publish it locally or globally. Evaluation decides the proposed promotion scope.

```ts
type Basis = "validated_learning" | "validated_fix" | "user_request";

interface MemoryRequest {
  action: "add" | "supersede" | "archive";
  id?: number;
  text?: string;
  evidence?: string;
  basis?: Basis;
  reason?: string;
}
```

The handler enforces these conditional requirements:

| Action | Required fields beyond `action` | Effect |
|---|---|---|
| `add` | `text`, `evidence`, `basis` | Stage a private candidate; no shared lesson is created |
| `supersede` | `id`, `text`, `evidence`, `basis` | Atomically create a linked replacement and archive the predecessor |
| `archive` | `id` | Exclude a retained lesson from recall; repeating an archive is a no-op |

`reason` is optional for every action. Project and session context are captured
automatically. Promotion still requires user approval. ID-based actions resolve
and retain the existing current-project or global scope; other-project IDs are
inaccessible.

A candidate is recalled only in its originating session/project. Pending
identity is originating project + normalized wording; retries from one session
do not add votes. The acknowledgement deliberately reveals no candidate IDs,
prior matches, or pool/occurrence counts.

Ordinary writes are blocked during staged audits/evaluations and memory reviews,
and through the remainder of their agent run until a fresh prompt. Ephemeral
sessions require `basis: "user_request"` for every ordinary write, including
archive.

### Results

```ts
type MemoryResult =
  | { status: "candidate staged"; message: string }
  | { status: "superseded"; id: number; supersedes_id: number | null; scope: string }
  | { id: number; archived: boolean; changed: boolean; scope: string };
```

Output `scope` identifies an already-active lesson's stored scope: its absolute
project-root path or `"global"`. It is not a submission preference. The archive
result has no `status` field.

```json
{
  "action": "add",
  "text": "Back up SQLite before applying schema changes.",
  "evidence": "Verified recovery from a database snapshot.",
  "basis": "validated_fix"
}
```

## `memory_audit`

Submit a complete proposal for a **user-requested active-lesson audit**. Obtain
`auditId` and permitted IDs from the current staged export; this tool cannot
start an audit or request arbitrary lessons/scopes.

```ts
type AuditChange =
  | { id: number; action: "archive"; reason: string }
  | { id: number; action: "move_global"; reason: string };

interface MemoryAuditRequest {
  auditId: string; // 1–80 characters; must match the current staged audit
  changes: AuditChange[]; // at most 10,000; empty means no warranted changes
}
```

- One action per audited active ID.
- TUI or RPC UI is required. **Apply all** commits the entire batch atomically;
  **Cancel** changes nothing. Moves include linked replacement history.
- A stale snapshot or duplicate destination rejects the batch. Session, branch,
  project/configuration changes, reload, and compaction invalidate the review.
- Do not apply the proposal through `memory`, commands, or shell writes.

### Results

```ts
type MemoryAuditResult =
  | { status: "no changes" }
  | { status: "cancelled"; message: string }
  | { status: "applied"; count: number; changes: Array<{
      id: number;
      action: "archive" | "move_global";
      from: string; scope: string;
      records?: number; // linked records moved, for move_global
    }> };
```

## `memory_evaluate`

Submit a complete proposal for a **user-requested candidate evaluation**. The
user starts it through `/pi-mem → Evaluate candidates…` or `/pi-mem evaluate`.
Only that deliberate export discloses the pending pool and prior judgments to
the current model. No background model calls or automatic promotions occur.

```ts
interface CandidateGroup {
  candidateIds: number[]; // 1–10,000 exported IDs, unique across all groups
  text: string;
  evidence: string;
  scope: "project" | "global";
  reason: string;
  recommend: boolean;
}

interface MemoryEvaluateRequest {
  evaluationId: string; // 1–80 characters; must match the current staged evaluation
  groups: CandidateGroup[]; // at most 10,000; must cover every exported candidate
}
```

Group only equivalent actionable lessons under the same conditions. Improve
combined wording without unsupported claims; keep uncertainty/conflicts separate
as singletons. Previous judgments are suggestions, not authority.

- Each exported candidate appears **exactly once**. Unknown/duplicate/omitted
  IDs are rejected. Project groups contain candidates from one originating project.
- Evaluation chooses project/global scope from evidence and applicability, not
  an agent-supplied preference. Code enforces configured independent-occurrence
  and distinct-project thresholds (defaults: project **2**; global **4** across
  **3** projects). Lineages deduplicate forks/retries; disclosure excludes later
  equivalent repetitions without invalidating earlier discoveries.
- TUI or RPC UI shows originals, evidence, dates, projects, origins and counts.
  **Yes** is available only for recommended, qualified groups. Selections may be
  revised and wording edited; they do not write active lessons immediately.
- **Finish evaluation** atomically saves matching judgments and approved
  promotions with provenance links. **No** or unselected groups stay pending.
  **Cancel** saves neither judgments nor promotions; prior disclosure remains.
- Stale or invalid state rejects completion. Unrelated new candidates arriving
  during review stay unevaluated. Only a completed evaluation updates the
  footer's `+new` watermark. Oversized exports fail without silent truncation.
- Do not apply proposals through `memory`, commands, or shell writes.

### Results

```ts
type MemoryEvaluateResult =
  | { status: "cancelled"; message: string }
  | { status: "evaluated";
      promoted: Array<{ groupIndex: number; lessonId: number; created: boolean }>;
      candidates: { pending: number; sinceEvaluation: number } };
```

`groupIndex` is zero-based. An approved promotion creates or reuses an active
lesson. `created: false` means an exact active duplicate was reused.
