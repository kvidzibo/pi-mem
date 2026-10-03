# pi-mem

[npm](https://www.npmjs.com/package/@kvidzibo/pi-mem) · [Pi package directory](https://pi.dev/packages)

SQLite-backed project and global memory for Pi. Agent additions become session-local candidates; evaluate and approve them before sharing. Active lessons are recalled automatically and can be superseded, archived, or reprioritized. Replacements preserve old records rather than overwriting them. There is no restore or delete operation.

No transcript harvesting, embeddings, or background model calls. Memory is stored and recalled through SQLite; Markdown is written only for explicit audit exports.

## Setup

Requires Pi **0.85.1+** (tested with 0.85.1), Node **22.19+**, and Git for repository scoping.

```bash
pi install npm:@kvidzibo/pi-mem
```

Append `@<version>` to the npm source to pin a version. Git installation remains available with `pi install git:github.com/kvidzibo/pi-mem` (append `@<tag-or-commit>` to pin it). For a local checkout, use `pi install /absolute/path/to/pi-mem`. Load the package once through `packages`, not also through `extensions`, then run `/reload` in existing Pi sessions.

Capture timing belongs to your agent's rules; this package does not change them. Configure selective saves of verified, reusable lessons during authorized work, or explicitly ask the agent to remember a lesson.

## Usage

The agent's `memory` tool exposes only:

- **`add`** — stage a provisional candidate with `text`, `evidence`, `basis` (`validated_learning`, `validated_fix`, or `user_request`), and integer `priority` **1–10** (1 highest). Only the originating session recalls it; other sessions receive no candidate text, matches, or occurrence counts.
- **`supersede`** — supply an active lesson's `id` and the new lesson fields. Priority is inherited unless supplied; model replacements always preserve a user's priority **0**. Creating the linked replacement and archiving its predecessor succeed together or neither does.
- **`archive`** — supply `id` to exclude that record from future recall while retaining its content and provenance.
- **`set_priority`** — supply an active lesson's `id` and `priority` **1–10**. Content and ID stay unchanged; models cannot reprioritize priority-0 lessons.

Agent submissions do not accept a scope. The originating project is captured automatically; evaluation proposes project or global promotion based on the evidence and configured thresholds, and the user approves it. ID-based actions retain the active lesson's scope and can target only current-project or global lessons. Pending candidate identity is project + normalized wording; active duplicate detection remains scope-local.

All three agent-exposed tools and their input/output interfaces are documented in [Agent tools](docs/agent-tools.md). Runtime JSON schemas are defined by `pi.registerTool` in [`src/index.ts`](src/index.ts).

Every tool action accepts an optional `reason` (up to 600 characters), retained in candidate provenance or the active lesson's activity log.

Priority measures future usefulness: consequences of ignoring the lesson, recurrence, then breadth. **1–2** prevents serious damage/corruption; **3–4** prevents recurring failures or expensive debugging; **5–6** is useful recurring knowledge; **7–8** covers narrow quirks; **9–10** has marginal future value. Priority guides attention, not instruction authority. **0** is user-reserved extreme priority; only human UI/commands can assign it. Duplicate adds never change priority. Unscored migrated records default to **5**; migration makes no model calls.

There are no agent read/search/history actions. An archived record cannot be superseded or restored. Exact repeated candidate submissions from one session retain the first observation; independently submitted wording/evidence remains separate provenance. Submission acknowledgements do not reveal prior matches. Human menu/command additions still save active lessons immediately; duplicate active wording returns its existing ID. Promotion reuses an exact active duplicate without changing its priority. Superseding rejects text already held by another active lesson without changing either record.

Run **`/pi-mem`** (formerly `/memory`) to open the project menu in TUI or RPC mode:

- Browse/search active or archived lessons by stable **#ID**, up to **1,000 items per page**; inspect evidence, origin, dates, and predecessor links. **Not recalled only** filters active lessons excluded from this session’s recall. Omission explanations identify whether the byte budget or lesson-count limit stopped recall; other projects are never recalled here.
- **Global lessons** opens shared active/archived lessons, with add, replace, priority, archive, and history actions. These lessons are recalled in every project using this database; whole-project moves exclude them.
- **All projects** searches stored project paths, including archived-only projects and missing folders. Rows show project names, active/archive counts, and paths (home abbreviated as `~`). Select a project to manage its lessons without switching cwd or recalling its memories here.
- Lesson details offer **Change priority…**, **Replace…**, **History**, moves, and **Archive**. The separate priority picker supports **0–10**; selecting a priority applies it immediately. Archive asks for confirmation, retains the record, and cannot be undone.
- Add lessons with priority **0–10**, review replacements, change an active lesson's priority without replacing its ID/content, or confirm archiving. Every change is recorded atomically in an append-only SQLite activity log. The TUI editor shows a live word count; RPC uses cancellable text inputs (blank keeps existing text). Editors and reviews identify the target project or global scope. Nothing saves until approval.
- **History** lists timestamped summaries such as “Priority changed: 5 → 2”. Open an event for its reason, actor, provider/model, harness/session, and replacement links. History follows project moves and stays out of automatic recall. Browsing, recall, failures, and no-ops are not logged. Model attribution comes from the assistant message issuing the tool call; missing attribution is marked unknown.
- **Move lesson to project…** or **Move lesson to global…** in lesson details moves only that lesson and its linked replacement history (including any successor), preserving IDs and metadata. Unrelated lessons stay put. Nonempty destinations are allowed; duplicate active text is refused atomically. Available for active and archived lessons; choose a known project or **Enter path…**. A project destination must be an existing directory and resolves to its canonical main Git worktree root or cwd. Global destinations need no path and are recalled across all projects using the database.
- **Move memory** lists all stored project paths, including archived-only projects and folders that no longer exist. Search/select a source, choose an empty known destination or **Enter path…** (prefilled with Pi’s cwd), then confirm. The destination must exist; its canonical main Git worktree root or cwd becomes the new scope. All lessons and archived history move together with IDs preserved. Occupied destinations are refused; no folders or files move. In RPC, blank input keeps the displayed default cwd.
- **Evaluate candidates…** sends **all pending candidates across all projects** to the current model, including original submissions, evidence, dates, origins, and previous similarity judgments. Menu dispatch asks for confirmation; `/pi-mem evaluate` authorizes it directly. This deliberately adds model-visible data and starts a turn; ordinary sessions never receive the candidate pool.
  - The model submits `memory_evaluate` with the staged evaluation ID and a complete partition of candidate IDs into equivalent groups or singletons. It proposes clearer combined wording, concise evidence, priority, scope, and a promotion recommendation. Conditions and commands must stay supported by the original evidence. Uncertain or conflicting advice should remain separate; past groupings are suggestions, not authority.
  - **Review candidate evaluation** lists suggested promotions and pending groups. Open a group for the proposed wording, original lessons, full evidence, submission timestamps, projects, sessions/models, and independent counts versus configured thresholds. Choose **Yes — promote**, **No — keep pending**, or **Edit wording…**. **Finish evaluation** saves all grouping judgments and only your Yes selections atomically; **Cancel evaluation** discards the proposal. No preserves candidates for later evaluation. Groups below thresholds cannot be promoted here.
  - Occurrences count independent discovery lineages, not retries, rewordings, or inherited forks. Global promotion also requires distinct independently represented projects and genuinely transferable advice. Disclosure records prevent later repetitions by an evaluator lineage from earning votes, including semantic rewordings later grouped with a disclosed candidate; discoveries submitted before disclosure remain valid. Exclusions survive promotion and later resubmissions with identical normalized wording, even when their candidate IDs change. Unrelated sessions without shared lineage metadata cannot be proven independent automatically.
  - Previous judgments, decisions, originals, and evidence remain in append-only tables. Promoted candidates link to the active lesson; no candidate or evidence is deleted. A new candidate arriving during review remains unevaluated and contributes to the footer's new count. Changes to reviewed observations, another evaluation, reload, tree navigation, compaction, or session changes invalidate the proposal. Use `/pi-mem evaluate cancel` to cancel a pending evaluation or close its review. The ordinary memory tool remains blocked until a fresh prompt after the evaluation run.
  - Approval requires TUI or RPC UI. Payloads are not silently truncated: when the estimated final export (including disclosure records) plus current conversation cannot fit the selected model, start a fresh session or choose a larger-context model. No automatic or background semantic model calls occur.
- **Audit…** reviews all active **current-project + global** lessons, or explicitly **all projects + global**, without recall/output limits. Each scope choice shows approximate tokens for the staged agent payload, including metadata and instructions, using characters/4 and compact units (e.g. `~1.2k tokens`); file exports can be smaller. Choose **Send to agent** for a staged proposal or **Export to file** for recommendations without an agent turn. A confirmation identifies the scope and destination; sending closes the menu before starting the agent turn. Includes full text, evidence, origin, dates, IDs, and priorities; archived records are excluded.
  - The agent submits structured changes through **`memory_audit`**, bound to that audit's snapshot and ID. Pi shows a scrollable **Review memory audit** with every lesson, source scope, proposed action, and reason. **Cancel** is selected by default; **Apply all** commits archives, priority changes, and moves to global across the audited scopes in one transaction. No manual commands or Markdown parsing are needed. Moves include linked replacement history; duplicate destination text rejects the entire batch. Archives retain records and cannot be restored.
  - Only IDs from that snapshot are eligible, with one action per ID and at most 10,000 proposed actions. Priority-0 lessons cannot be changed, and proposed priorities must be 1–10. Changes to affected lessons since export—including changes later reversed—reject the batch. Cancel or interruption of the review, session/branch changes, compaction, and memory reload invalidate the proposal; run a new audit to retry. Use **`/pi-mem audit cancel`** to discard an unanswered audit or close its approval dialog. Approval requires TUI or RPC UI; print/JSON mode cannot apply proposals. Empty proposals finish without a dialog or writes.
  - The ordinary **`memory`** tool stays restricted to current-project/global scope and is blocked while an audit or memory review is pending, and through the remainder of the audit agent run. The separate audit tool cannot request arbitrary scopes, read lessons, or apply changes without UI approval. History records the approving user and, when available, the proposing model. File exports remain recommendation-only; they do not stage a proposal or authorize mutations.
- **Backups…** configures **Off / Daily / Weekly / Monthly** automatic backups (default Off), selects an existing **Backup folder…**, runs **Back up now**, or opens **Backup statistics**. Statistics show the selected folder, last successful backup's time/path/size and active/archived lesson counts, backup-file count, and total folder size. Backups include all projects, global lessons, candidates, evaluations, and retained history, not just the current project.
- Inspect read-only status and limits, reload memory, or open help. Initialization failures still allow status/help/reload.

Use arrow keys and Enter to navigate, Escape to go back/close, and Page Up/Down to scroll long details (respecting configured keybindings). Browsing stays out of conversation history and makes no model calls; sending an audit deliberately adds model-visible data and starts a turn. In the terminal browser, type to filter lesson text/evidence immediately (literal substring, up to 200 characters); Backspace edits the query. RPC clients retain the Search dialog. Search, recall filter, and page selection survive returning from lesson details. Session changes or memory reloads invalidate pending menu actions.

The footer shows `🧠 project|global (+A -R) ~N · 🌱 C (+new)` (for example, `🧠 8|4 (+2 -1) ~850 · 🌱 12 (+3)`). Brain counts are loaded active lessons only. **🌱** counts pending candidates across the whole database; `+new` counts pending candidate identities first added since the last **completed** evaluation. Starting or cancelling an evaluation does not reset it; additional observations of an existing candidate are not new candidate identities. Omission details stay in the menu. `~N` is the estimated token count, using Pi's compact units (e.g. `~132`, `~1.2k`, `~12k`, `~1.2M`); the whole status has a space on either side. Zero session-change counts are omitted. Change counts and tokens combine current-project and global lessons. It tracks this session's additions and archives separately: adding then archiving gives `(+1 -1)`, as does superseding an existing lesson. Duplicates and already-archived records do not count again. Counts survive reload/resume; new sessions and forks start at zero. Other sessions' changes do not count.

Saves and archives in the current project or global scope add chat entries with the lesson ID and text (plus the predecessor ID for replacements). Audit archives suppress these chat cards while retaining session footer counts and database history. These entries are stored in the Pi session, not added to model context; browsing remains private. Changes to other projects retain database activity history but do not add chat entries or affect this session's change counts.

Tokens use Pi's characters/4 estimate, not a model-specific tokenizer. The footer counts the current SQLite snapshot—active lessons and this session's provisional candidates, priorities, IDs, and headings—not the accumulated recall updates in the model context. Evidence, other metadata, and omitted/archived lessons are excluded from the estimate.

Direct commands remain available; without UI, `/pi-mem` retains its text status output:

| Command | Purpose |
|---|---|
| `/pi-mem` | Open the project memory menu; text status without UI |
| `/pi-mem global add\|list\|archived\|search …` | Run these commands in global scope; ID commands resolve either current-project or global IDs |
| `/pi-mem add [--priority 0–10] <lesson>` | Save explicitly; default priority 5 |
| `/pi-mem supersede <id> [--priority 0–10] <lesson>` | Replace and archive the original; inherit priority by default |
| `/pi-mem priority <id> <0–10>` | Change active priority without replacing content |
| `/pi-mem archive <id>` | Archive without deleting |
| `/pi-mem move <id> <destination-path\|--global\|--project>` | Move lesson and linked history, preserving IDs; `--global` selects shared scope, `--project` selects the current project; paths may contain spaces, without quotes |
| `/pi-mem list [offset]` | Page through active lessons |
| `/pi-mem archived [offset]` | Page through archived records |
| `/pi-mem search <text>` | Search active text/evidence by literal substring |
| `/pi-mem get <id>` | Inspect a retained record and its predecessor link |
| `/pi-mem history <id> [offset]` | Inspect activity, five entries per page with `nextOffset` |
| `/pi-mem audit [--all-projects]` | Send every active current-project + global lesson for a staged agent proposal, then Apply all / Cancel; the flag explicitly includes all projects |
| `/pi-mem audit cancel` | Discard a pending audit or close its approval dialog without writes |
| `/pi-mem evaluate` | Send all pending candidates to the current model; review individual promotions and finish the evaluation |
| `/pi-mem evaluate cancel` | Cancel a pending evaluation/review; candidates remain pending |
| `/pi-mem audit [--all-projects] --file <path>` | Export the same audit to a new Markdown file; no agent turn; paths may contain spaces, without quotes |
| `/pi-mem reload` | Reread configuration and reconnect; also retries initialization failures |
| `/pi-mem help` | Show command help |

IDs are stable positive integers, unique across the database and never reused—not list positions. Use the number from a lesson's `#id` suffix; commands also accept `#42` instead of `42`. UUIDs are discarded during migration and are no longer valid references. Direct list/archived command pages return `nextOffset`; ordinary command output is capped at 30 records and 16 KiB. Audits bypass those limits and recall budgets; large agent audits may exceed the selected model's context window, so use file export instead. Audit files are created with private permissions (`0600`), never overwrite existing files/symlinks, and require an existing parent directory. Relative export paths resolve against Pi's cwd; `~/` is supported. Keep exports out of Git. Agent audits send evidence and origins as well as lessons and project paths to the selected model and retain them in session history. These explicit commands authorize export/dispatch immediately; menu audits ask for confirmation. Search returns one bounded page, with SQLite's ASCII case-insensitive matching.

`--no-session` still recalls memory. Agent writes in ephemeral sessions require `basis: "user_request"`; explicit user commands remain available.

## Configuration and recall

Defaults, in `<Pi agent directory>/pi-mem.json` (normally `~/.pi/agent/pi-mem.json`):

```json
{
  "databasePath": "memory.sqlite3",
  "maxLessonWords": 20,
  "maxEvidenceWords": 20,
  "maxRecallLessons": 30,
  "maxRecallBytes": 8192,
  "projectMinOccurrences": 2,
  "globalMinOccurrences": 4,
  "globalMinProjects": 3
}
```

`PI_MEMORY_DB` overrides the database path. Relative paths resolve against the Pi agent directory, **not the project**; `~` expands to the home directory and `PI_CODING_AGENT_DIR` is respected. Project-local configuration cannot redirect storage. Changing paths selects another store; it does not move data. Run `/pi-mem reload` after configuration changes.

Limits must be positive safe integers; `maxRecallBytes` must be at least **64** to fit the recall heading and omission notice. It counts UTF-8 bytes, not tokens. For 100 short lessons, `maxRecallLessons: 100` with `maxRecallBytes: 32768` (32 KiB) is a reasonable starting budget; unusually long lessons may still be omitted.

Promotion thresholds are positive safe integers. Project groups require `projectMinOccurrences` independent lineages in one project; global groups require both `globalMinOccurrences` lineages and `globalMinProjects` distinct independently represented projects. These are eligibility requirements, not automatic promotion or proof of truth. Explicit human menu/command additions bypass candidate evaluation.

Words are whitespace-separated; overlong saves fail rather than truncate. Text/evidence also have hard caps of 1,200/600 characters. Lowering limits does not rewrite existing lessons.

- **Scope:** the canonical main Git worktree root, or canonical cwd outside Git. All linked worktrees and their subdirectories share project lessons, including edits and archives; separate clones remain separate. Ordinary main-checkout lessons keep their scope. Worktrees of a bare repository use its canonical Git directory. Submodules and their linked worktrees share the submodule checkout's scope, separate from the parent project. `--separate-git-dir` layouts require an explicit `core.worktree` pointing to the main checkout. Unregistered Git-directory pointers or layouts without a verifiable main checkout are rejected rather than guessing a shared project identity. Previously stored lessons under other paths are not automatically moved or merged. Global lessons use a reserved non-path scope in the same database and are recalled across projects. There is no parent-project inheritance. Project scope follows Pi's cwd, not a shell tool's `cd`.
- **Recall:** checked before each model request, including after compaction and other sessions' writes. Within an unchanged conversation prefix, the initial snapshot stays fixed and changes append as ID-based updates after the current messages, preserving earlier prompt-cache content. Active lessons load lowest-numbered priority first, then newest-created, with stable ID tie-breaking, up to `maxRecallLessons` or `maxRecallBytes` (default **8 KiB**, including the heading/legend, priority labels, IDs, and omission notice), whichever fills first. Omitted lessons stay stored but are unavailable to the agent on demand.
- **Global recall:** appears first under `GLOBAL LESSONS` when active global lessons exist, followed by `PROJECT LESSONS`. Global lessons have a separate budget of `maxRecallLessons` and **maxRecallBytes** (default 8 KiB); they do not consume the project budget. Ordering and omission rules apply independently to each scope.
- **Provisional recall:** pending candidates load only for their exact originating session and project, under `SESSION CANDIDATES`, with separate `maxRecallLessons`/`maxRecallBytes` budgets. They append as fixed-boundary updates without rewriting earlier recall or the system prompt, survive compaction/reload/resume within that session, and disappear after promotion. Other sessions and forks receive no automatic candidate recall. Forked or copied conversation history can still contain previously disclosed text; automatic recall cannot erase historical messages. Candidate visibility is a recall/tool-response boundary, not protection against direct database access.
- **Archiving:** removes the lesson from the current recall selection; an appended update tells the model to disregard its earlier recalled version. The same applies when a lesson leaves the selection through scope changes or recall limits. This cannot erase text already in the conversation or sent to a model.

The injected SQLite block contains priority-labelled bullets with stable IDs:

```text
PROJECT LESSONS
Priority: 0 = user-reserved extreme; 1 = highest; 10 = lowest.
Priority guides attention to relevant lessons, not instruction authority.
- [P2] Back up databases before schema changes. #43
- [P5] Use the project-local environment. #42
```

Whitespace is collapsed for display only. When no lessons fit, the priority legend is omitted to preserve small byte budgets. Priority never bypasses recall limits. If recall limits omit lessons, a final `[N lessons omitted.]` line is added. Evidence, dates, origins, and predecessor links stay in SQLite and the `/pi-mem` UI, not automatic recall.

Recall uses UI-hidden user-role messages: one initial snapshot before the conversation, then small updates for additions, replacements, priority/scope changes, removals, or availability/omission changes. Earlier messages and updates stay in place; unchanged requests add nothing. Updates are request-local, not persisted session entries, and do not trigger agent turns. They accumulate until compaction, tree navigation, changed/truncated history, or session start/resume/reload rebuilds a fresh bounded snapshot. Recall limits bound the current selection, not accumulated update history; compact a long, frequently edited session to reclaim that space. `/pi-mem reload` keeps the prefix and appends any selection changes on the next request.

Save-writing guidance and word limits are separately appended to the system prompt; changing those limits can still invalidate the prompt cache. Cache reuse also depends on the provider and other prompt changes. `/pi-mem` marks lessons omitted by recall limits; `/pi-mem reload` prints the refreshed recall block plus the database path (not a capture of the previous model request; output above 16 KiB can be clipped).

## Privacy, backups, and upgrades

- Store no secrets or raw transcripts. SQLite storage is local and newly created database files are private (`0600`), but **not encrypted**. Recalled lessons and project paths go to the selected model, including hosted providers. Print/JSON command reports can persist in session history and later model context.
- Use a **local filesystem with SQLite WAL support**, not a concurrently accessed network share. Use SQLite's backup API/command, or close all connections before copying; copying only a live database file can omit WAL data. WAL setup retries lock contention with a two-second budget; persistent contention fails initialization.
- Built-in backups use SQLite's online backup API, include committed WAL data, validate the snapshot, and publish a new timestamped file without overwriting existing files. Files are private (`0600`), but not encrypted. **No backups are automatically deleted.** Keep the backup folder outside Git and monitor disk usage.
- Automatic backups run at **Pi process startup**, not when opening the menu, starting a new conversation, or reloading. Daily/monthly schedules use local calendar days/months; weeks start Monday. With no previous success in the selected folder, the next startup backs up immediately. A manual backup also satisfies the current scheduled period. Missed periods produce one current snapshot, not historical catch-up copies. Simultaneous startups share a database-level claim; a startup skips if another backup is already running. Failures do not advance the schedule and retry at a later startup.
- After a startup backup, a report above the editor shows the file, its size, active/archived lesson counts, and total backup-folder size. It survives `/reload`, clears at the next submitted input, and never starts an agent turn or enters model context. RPC clients receive the same widget report. Manual backups show a result screen.
- The default folder is `<database-file>.backups` beside the database, created privately when first used. Choose another existing directory through the menu; relative paths resolve against Pi cwd and `~/` is supported. Changing folders does not move or delete files. Statistics use the selected folder: total size recursively includes all regular files, excluding symlinks; backup-file count includes recognized pi-mem snapshots from any database there. Last-backup details track successful backups made by this database into that folder; manually copied files do not reconstruct those details.
- Backup settings and last-success metadata are shared by all sessions using the database and saved separately in `<database-file>.backups.sqlite3`; they are not part of the lesson snapshot or `pi-mem.json`. Changing `PI_MEMORY_DB` selects separate backup settings. The backup folder and sidecar need local filesystem locking support. Backup failure does not disable memory recall or writes.
- To restore, **close every Pi connection to this database first**, preserve the current database and any WAL/SHM files as a recovery copy, then replace the database with the chosen snapshot and remove the old WAL/SHM from the live path. Keep private permissions and use code compatible with the snapshot's schema. Reopen Pi and verify lessons/history. There is no in-app restore or automatic pre-upgrade backup; use **Back up now before upgrading**, even if scheduling is enabled.
- Global scope needs no new schema migration. Older versions do not recall global lessons and cannot manage their reserved scope; reload all sessions after upgrading.
- **Back up before upgrading.** Schema v1–v7 databases upgrade atomically to **v8** on open. V8 adds candidate submissions, disclosure records, evaluations, similarity groups/memberships, and promotion links; existing active lessons are not converted into candidates. Pre-v6 records initially receive priority **5**; v6 priorities and priority-change history are preserved. Lesson content and history are retained; old UUIDs are used only to remap predecessor links, then discarded. Existing integer IDs remain unchanged. Historical activity is reconstructed only from retained facts; missing actors, models, dates, and earlier changes remain unknown. Existing lessons can then be explicitly reviewed and reprioritized; no automatic model scoring runs on startup. Previously overwritten content cannot be recovered. Older releases cannot open v8: keep v8-capable code or a compatible backup for rollback. `/reload` **all** Pi sessions after upgrading; already-open old clients are not compatible with migrated storage.

## Development and validation

On Linux, install Git, `xvfb`, and `xauth`, then run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm audit
```

`npm test` runs TypeScript checks, storage tests, and Pi loader/RPC integration tests. UI/protocol checks use `xvfb-run`; tests use disposable databases and no live-model calls.

## Publishing

One-time bootstrap: after review, run `npm login` and `npm publish --ignore-scripts` for the first release. In npm package settings, add a GitHub Actions trusted publisher with owner **kvidzibo**, repository **pi-mem**, and workflow **publish.yml** (no environment). Allow direct `npm publish`. CI uses OIDC, not your local login or an npm token secret.

For later releases, bump `package.json` and `package-lock.json` together (`npm version patch --no-git-tag-version`, or `minor`/`major`) in a PR. Every push to `main` runs `.github/workflows/publish.yml`: tests on Node 22.19 and 24 must pass before a new version publishes publicly with provenance. Already-published versions are skipped; registry lookup failures stop publishing. Only stable versions are supported. No release tag is needed.

## License

[MIT](LICENSE).
