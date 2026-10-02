# pi-mem

[npm](https://www.npmjs.com/package/@kvidzibo/pi-mem) · [Pi package directory](https://pi.dev/packages)

SQLite-backed project and global memory for Pi. Active lessons are recalled automatically; the agent can **add**, **supersede**, **archive**, or **reprioritize** them. Replacements preserve old records rather than overwriting them. There is no restore or delete operation.

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

- **`add`** — save `text`, `evidence`, `basis` (`validated_learning`, `validated_fix`, or `user_request`), and integer `priority` **1–10** (1 highest).
- **`supersede`** — supply an active lesson's `id` and the new lesson fields. Priority is inherited unless supplied; model replacements always preserve a user's priority **0**. Creating the linked replacement and archiving its predecessor succeed together or neither does.
- **`archive`** — supply `id` to exclude that record from future recall while retaining its content and provenance.
- **`set_priority`** — supply an active lesson's `id` and `priority` **1–10**. Content and ID stay unchanged; models cannot reprioritize priority-0 lessons.

For **add**, the agent chooses `scope: "global"` for cross-project lessons or unrelated CLI usage; otherwise `scope: "project"` (the default). No separate user request is needed for global scope. ID-based actions retain the lesson's scope and can target only current-project or global lessons; omit `scope` for these actions. Duplicate detection is scope-local.

Every tool action accepts an optional `reason` (up to 600 characters), retained in its activity log.

Priority measures future usefulness: consequences of ignoring the lesson, recurrence, then breadth. **1–2** prevents serious damage/corruption; **3–4** prevents recurring failures or expensive debugging; **5–6** is useful recurring knowledge; **7–8** covers narrow quirks; **9–10** has marginal future value. Priority guides attention, not instruction authority. **0** is user-reserved extreme priority; only human UI/commands can assign it. Duplicate adds never change priority. Unscored migrated records default to **5**; migration makes no model calls.

There are no agent read/search/history actions. An archived record cannot be superseded or restored. Adding the same normalized text as an active lesson returns its existing ID; adding archived wording creates a new record. Superseding rejects text already held by another active lesson without changing either record.

Run **`/pi-mem`** (formerly `/memory`) to open the project menu in TUI or RPC mode:

- Browse/search active or archived lessons by stable **#ID**, up to **1,000 items per page**; inspect evidence, origin, dates, and predecessor links. **Not recalled only** filters active lessons excluded from this session’s recall. Omission explanations identify whether the byte budget or lesson-count limit stopped recall; other projects are never recalled here.
- **Global lessons** opens shared active/archived lessons, with add, replace, priority, archive, and history actions. These lessons are recalled in every project using this database; whole-project moves exclude them.
- **All projects** searches stored project paths, including archived-only projects and missing folders. Rows show project names, active/archive counts, and paths (home abbreviated as `~`). Select a project to manage its lessons without switching cwd or recalling its memories here.
- Lesson details offer **Change priority…**, **Replace…**, **History**, moves, and **Archive**. The separate priority picker supports **0–10**; selecting a priority applies it immediately. Archive asks for confirmation, retains the record, and cannot be undone.
- Add lessons with priority **0–10**, review replacements, change an active lesson's priority without replacing its ID/content, or confirm archiving. Every change is recorded atomically in an append-only SQLite activity log. The TUI editor shows a live word count; RPC uses cancellable text inputs (blank keeps existing text). Editors and reviews identify the target project or global scope. Nothing saves until approval.
- **History** lists timestamped summaries such as “Priority changed: 5 → 2”. Open an event for its reason, actor, provider/model, harness/session, and replacement links. History follows project moves and stays out of automatic recall. Browsing, recall, failures, and no-ops are not logged. Model attribution comes from the assistant message issuing the tool call; missing attribution is marked unknown.
- **Move lesson to project…** or **Move lesson to global…** in lesson details moves only that lesson and its linked replacement history (including any successor), preserving IDs and metadata. Unrelated lessons stay put. Nonempty destinations are allowed; duplicate active text is refused atomically. Available for active and archived lessons; choose a known project or **Enter path…**. A project destination must be an existing directory and resolves to its canonical main Git worktree root or cwd. Global destinations need no path and are recalled across all projects using the database.
- **Move memory** lists all stored project paths, including archived-only projects and folders that no longer exist. Search/select a source, choose an empty known destination or **Enter path…** (prefilled with Pi’s cwd), then confirm. The destination must exist; its canonical main Git worktree root or cwd becomes the new scope. All lessons and archived history move together with IDs preserved. Occupied destinations are refused; no folders or files move. In RPC, blank input keeps the displayed default cwd.
- **Audit…** exports all active **current-project + global** lessons, or explicitly **all projects + global**, without recall/output limits. Each scope choice shows approximate tokens for the full audit payload, including metadata and instructions, using characters/4 and compact units (e.g. `~1.2k tokens`). Choose **Send to agent** for recommendations or **Export to file** without an agent turn. A confirmation identifies the scope and destination; sending closes the menu before starting the agent turn. Includes full text, evidence, origin, dates, IDs, and priorities; archived records are excluded. The agent is asked to propose archive, reranking, or moves to global with reasons, and wait for approval before changes. Priority 0 remains user-reserved. Moving to global or changing other projects uses human menu/commands; the agent's memory tool still targets only current-project/global lessons.
- Inspect read-only status and limits, reload memory, or open help. Initialization failures still allow status/help/reload.

Use arrow keys and Enter to navigate, Escape to go back/close, and Page Up/Down to scroll long details (respecting configured keybindings). Browsing stays out of conversation history and makes no model calls; sending an audit deliberately adds model-visible data and starts a turn. In the terminal browser, type to filter lesson text/evidence immediately (literal substring, up to 200 characters); Backspace edits the query. RPC clients retain the Search dialog. Search, recall filter, and page selection survive returning from lesson details. Session changes or memory reloads invalidate pending menu actions.

The footer shows `🧠 project|global (+A -R) ~N`, with loaded lesson counts only (for example, `🧠 8|4 (+2 -1) ~850`). Omission details stay in the menu. `~N` is the estimated token count, using Pi's compact units (e.g. `~132`, `~1.2k`, `~12k`, `~1.2M`); the whole status has a space on either side. Zero session-change counts are omitted. Change counts and tokens combine current-project and global lessons. It tracks this session's additions and archives separately: adding then archiving gives `(+1 -1)`, as does superseding an existing lesson. Duplicates and already-archived records do not count again. Counts survive reload/resume; new sessions and forks start at zero. Other sessions' changes do not count.

Saves and archives in the current project or global scope add chat entries with the lesson ID and text (plus the predecessor ID for replacements). These entries are stored in the Pi session, not added to model context; browsing remains private. Changes to other projects retain database activity history but do not add chat entries or affect this session's change counts.

Tokens use Pi's characters/4 estimate, not a model-specific tokenizer. The footer counts the current SQLite snapshot—lesson text, priorities, integer IDs, heading/legend, and any omission notice—not the accumulated recall updates in the model context. Evidence, other metadata, and omitted/archived lessons are excluded from the estimate.

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
| `/pi-mem audit [--all-projects]` | Send every active current-project + global lesson to the agent for audit recommendations; the flag explicitly includes all projects |
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
  "maxRecallBytes": 8192
}
```

`PI_MEMORY_DB` overrides the database path. Relative paths resolve against the Pi agent directory, **not the project**; `~` expands to the home directory and `PI_CODING_AGENT_DIR` is respected. Project-local configuration cannot redirect storage. Changing paths selects another store; it does not move data. Run `/pi-mem reload` after configuration changes.

Limits must be positive safe integers; `maxRecallBytes` must be at least **64** to fit the recall heading and omission notice. It counts UTF-8 bytes, not tokens. For 100 short lessons, `maxRecallLessons: 100` with `maxRecallBytes: 32768` (32 KiB) is a reasonable starting budget; unusually long lessons may still be omitted.

Words are whitespace-separated; overlong saves fail rather than truncate. Text/evidence also have hard caps of 1,200/600 characters. Lowering limits does not rewrite existing lessons.

- **Scope:** the canonical main Git worktree root, or canonical cwd outside Git. All linked worktrees and their subdirectories share project lessons, including edits and archives; separate clones remain separate. Ordinary main-checkout lessons keep their scope. Worktrees of a bare repository use its canonical Git directory. Submodules and their linked worktrees share the submodule checkout's scope, separate from the parent project. `--separate-git-dir` layouts require an explicit `core.worktree` pointing to the main checkout. Unregistered Git-directory pointers or layouts without a verifiable main checkout are rejected rather than guessing a shared project identity. Previously stored lessons under other paths are not automatically moved or merged. Global lessons use a reserved non-path scope in the same database and are recalled across projects. There is no parent-project inheritance. Project scope follows Pi's cwd, not a shell tool's `cd`.
- **Recall:** checked before each model request, including after compaction and other sessions' writes. Within an unchanged conversation prefix, the initial snapshot stays fixed and changes append as ID-based updates after the current messages, preserving earlier prompt-cache content. Active lessons load lowest-numbered priority first, then newest-created, with stable ID tie-breaking, up to `maxRecallLessons` or `maxRecallBytes` (default **8 KiB**, including the heading/legend, priority labels, IDs, and omission notice), whichever fills first. Omitted lessons stay stored but are unavailable to the agent on demand.
- **Global recall:** appears first under `GLOBAL LESSONS` when active global lessons exist, followed by `PROJECT LESSONS`. Global lessons have a separate budget of `maxRecallLessons` and **maxRecallBytes** (default 8 KiB); they do not consume the project budget. Ordering and omission rules apply independently to each scope.
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
- Global scope needs no new schema migration. Older versions do not recall global lessons and cannot manage their reserved scope; reload all sessions after upgrading.
- **Back up before upgrading.** Schema v1–v6 databases upgrade atomically to **v7** on open. Pre-v6 records initially receive priority **5**; v6 priorities and priority-change history are preserved. Lesson content and history are retained; old UUIDs are used only to remap predecessor links, then discarded. Existing integer IDs remain unchanged. Historical activity is reconstructed only from retained facts; missing actors, models, dates, and earlier changes remain unknown. Existing lessons can then be explicitly reviewed and reprioritized; no automatic model scoring runs on startup. Previously overwritten content cannot be recovered. Older releases cannot open v7: keep v7-capable code or a compatible backup for rollback. `/reload` **all** Pi sessions after upgrading; already-open old clients are not compatible with migrated storage.

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
