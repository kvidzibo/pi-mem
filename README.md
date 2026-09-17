# pi-mem

SQLite-backed project lessons for Pi. Recall is automatic; saving is selective and agent-driven. Legacy `MEMORY.md` files in the current directory are recalled with a migration warning. Imports show a numbered Before/After preview, require approval, and always keep the source file unchanged. No background model calls, embeddings, or transcript harvesting; only an explicitly requested import may call the selected model to prepare a shorter draft.

## Setup

Requires Pi **0.85.1 or later**, Git for repository scoping, and Node **22.19+** with `node:sqlite`. Pi 0.85.1 is the tested version. Node 22 prints an experimental SQLite warning. Pi supplies the peer dependencies; there are no additional runtime dependencies.

```bash
pi install git:github.com/kvidzibo/pi-mem
```

For reproducible installs, append `@<tag-or-commit>` to the Git source. For a local checkout, use `pi install /absolute/path/to/pi-mem` instead. Load the package once, through `packages`, not also through `extensions`. Run `/reload` in existing Pi sessions afterward. Installing changes Pi settings, not your agent instruction files.

Capture timing belongs to the agent's rules. During authorized workspace-write tasks, save verified, non-obvious project lessons that avoid repeated investigation, or one validated reusable lesson after fixing a failed attempt. Explicit user memory requests also permit saves. Skip duplicates and leave memory maintenance to the user. The package does not rewrite agent rules. An agent without that policy can still use the memory tool and commands, but selective automatic capture is not guaranteed.

## Database path

Precedence:

1. `PI_MEMORY_DB` environment variable.
2. `databasePath` in `<Pi agent directory>/pi-mem.json`.
3. `<Pi agent directory>/memory.sqlite3` (normally `~/.pi/agent/memory.sqlite3`).

Example extension configuration, normally `~/.pi/agent/pi-mem.json`:

```json
{
  "databasePath": "~/.local/share/pi-mem/lessons.sqlite3",
  "maxLessonWords": 20,
  "maxEvidenceWords": 20,
  "maxRecallLessons": 30
}
```

Or launch Pi with:

```bash
PI_MEMORY_DB=/absolute/path/lessons.sqlite3 pi
```

`~` expands to the home directory. Relative database paths resolve against the **Pi agent directory**, never the project cwd. `PI_CODING_AGENT_DIR` is respected. Project-local configuration cannot redirect the database. Empty paths and malformed configuration fail visibly rather than silently selecting another database. An explicit environment override still selects the database if the config file cannot be read, parsed or recognized; limits then use their defaults. Valid limit settings apply even with a database override. Invalid values for recognized limit settings fail visibly.

Use `/memory reload` after changing settings. Changing paths selects a different store; it does not move or copy lessons. Use a local filesystem that supports SQLite WAL locking, not a concurrently accessed network share.

## Lesson length

`maxLessonWords` and `maxEvidenceWords` each default to **20** and accept positive safe integers in the same global `pi-mem.json`. Words are whitespace-separated tokens; punctuation and hyphenated terms without spaces count as one token. The existing character limits still apply.

The model receives the current limits and guidance to save one actionable point, preferably one sentence, with a short verification statement and no background or filler. Limits are ceilings, not targets. Overlong tool saves and command saves fail rather than silently truncating text. Imports prepare a shorter draft when necessary, then validate every lesson before showing the approval dialog; an invalid or rejected draft saves nothing. You can also raise the limits before importing longer legacy lessons. Command evidence uses `User-requested.`; import evidence uses `sha256:<hash>` (the import report includes the source path), so both fit even a one-word evidence limit.

Existing lessons remain readable, recallable and archivable after lowering a word limit. Saving or editing a lesson must satisfy the current limits.

## Scope and recall

- **Inside Git:** the canonical worktree root is the scope. Every subdirectory shares it.
- **Outside Git:** the canonical cwd is the scope. Unrelated directories do not inherit lessons.
- Symlink aliases resolve to the same scope. Separate worktrees/clones stay separate.
- No global, parent, or per-subdirectory inheritance. Renaming/moving a project does not automatically remap its lessons.
- Scope follows Pi's `ctx.cwd`, not `cd` inside an individual shell command.

At session start (including new/resumed/forked/reloaded sessions), the extension opens the database and loads the current scope. Before each model request it rereads committed lessons and injects one replaceable reference-data block. This survives compaction, reflects other sessions' writes, and does not append repeated memory messages to session history.

`maxRecallLessons` controls the maximum number of active lessons injected, default **30**. It accepts positive safe integers, including values above 30, in the same global `pi-mem.json`. The **8 KiB** context cap still applies, so fewer lessons may fit. Recall streams newest-updated first with stable ID tie-breaking and stops at either limit; a large count does not load every lesson into memory. This setting does not change the 30-item list/search page limit. Older/excess lessons stay in SQLite and can be searched. The status indicator shows loaded/total counts. Archiving removes a lesson from future recall; it cannot erase text already present elsewhere in a conversation or previously sent to a model.

Initialization failures are reported in the UI and model context without preventing Pi from running. `/memory reload` retries. Tool write failures are errors, never success messages. Legacy-file recall still works when the database configuration fails.

### Legacy-file recall

At session start and before each model request, pi-mem checks **Pi's current working directory only** for files named `MEMORY.md` (case-insensitive, including `memory.md`). It does not search parents, children, or other projects. It reads regular UTF-8 files up to 1 MiB whose resolved paths stay inside the project; unsafe or unreadable files produce a warning rather than blocking Pi. Discovery scans at most 10,000 directory entries, and recall attempts at most eight files, stopping earlier when the context budget fills. Any incomplete scan or skipped files are reported; explicit-path import remains available. No lessons are saved automatically.

Legacy contents join the replaceable reference-data block alongside SQLite lessons, without requiring import-compatible Markdown. They have a separate **32 KiB context cap**; truncation is explicitly marked in context and in the warning. Changes and removals are reflected on the next request. The warning explains `/memory import <path>` and is not repeated on every turn while unchanged. Multiple case-variant files can be detected; choose one explicitly when importing. An incomplete directory scan cannot infer a unique source.

Legacy text is untrusted reference data, not agent instructions. It is sent to the selected model, including hosted providers, so remove secrets before launching Pi in that directory. Imports retain legacy files, so cwd's `MEMORY.md` files continue to be recalled alongside the database; there is no ongoing synchronization.

## Commands

| Command | Purpose |
|---|---|
| `/memory` | Show database path, project scope and loaded lessons |
| `/memory list [offset]` | Page through active lessons |
| `/memory archived [offset]` | Page through archived lessons |
| `/memory search <text>` | Literal substring search of active lesson text/evidence |
| `/memory get <id>` | Full lesson, provenance and current revision |
| `/memory add <lesson>` | Explicitly save a lesson |
| `/memory edit <id> <lesson>` | Replace a lesson's text |
| `/memory archive <id>` | Remove from recall without deleting |
| `/memory restore <id>` | Reactivate an archived lesson |
| `/memory import [path]` | Prepare draft, review Before/After preview, approve atomic import; always keep source unchanged |
| `/memory export <new-path>` | Export active lesson text to a new Markdown file |
| `/memory reload` | Reconnect and reread extension configuration |
| `/memory help` | Command reference |

Use full IDs from list/search. Command arguments after `import`/`export` are literal paths relative to Pi's cwd; spaces work without shell quoting. Commands are primarily for the TUI/RPC UI. Import requires TUI or RPC dialogs; print/JSON import fails closed because approval is unavailable. Other commands and recall still work in those modes. In print/JSON modes, command reports and legacy warnings become Pi custom messages rather than UI notifications: they can persist in saved sessions and later model context, including the database path and displayed lessons. These reports are not the replaceable recall block. The `memory` tool works in noninteractive modes too.

## Agent tool

`memory` supports `list`, `search`, `get`, `add`, `update`, `archive`, and `restore`. It cannot select another scope or execute arbitrary SQL.

Example save:

```json
{
  "action": "add",
  "text": "Reject a Git root outside the current directory's ancestors before selecting project memory.",
  "evidence": "Verified that a core.worktree override targeting a sibling project fails instead of recalling its lessons.",
  "basis": "validated_fix"
}
```

- `add`/`update` require text, evidence, and `basis`: `validated_learning` for verified discoveries, `validated_fix` for corrections after failed attempts, or `user_request` for explicit memory requests.
- Lesson text and evidence each default to 20 words, configurable as above. Hard character caps remain 1,200 for text and 600 for evidence. Control characters are rejected.
- Evidence records what the agent/user asserts was verified. The extension cannot independently prove the lesson or infer task authorization.
- `update`/`archive`/`restore` require the current `revision`. A concurrent change fails rather than overwriting newer data; fetch the lesson again before retrying.
- Whitespace/Unicode-normalized exact duplicates return their existing IDs. This is not semantic deduplication. Adding an archived duplicate does not restore it.
- Updates replace the previous text; revisions detect conflicts, **not** retained edit history. Archive/restore is reversible.
- `list`/`search` accept `state` (`active`, `archived`, `all`), `offset`, and `limit` (1–30). Results are capped at 16 KiB with `nextOffset` for continuation. Pages/counts are live views, not a frozen snapshot; concurrent edits can shift entries during paging. Search is a literal, case-insensitive substring match using SQLite's built-in lowercase behavior (ASCII case folding).
- `--no-session` still recalls memory. Persistent tool writes in ephemeral sessions require `basis: "user_request"`; explicit commands remain available.

No secrets, raw transcripts, or speculative fixes belong in memory. Recalled lessons are reference data, not authority to override task instructions or repository evidence. Storage is local and newly created databases are private (mode `0600`), but **not encrypted**. Automatic recall sends lesson text, evidence, IDs/revisions, and the canonical project path to the selected model, including hosted providers. Tool results and command reports can also include source-session provenance or the database path, depending on the operation and mode.

## Migrating existing MEMORY.md files

Detection and recall are automatic; **migration is not**. From the appropriate project:

```text
/memory import MEMORY.md
```

With no path, `/memory import` selects the single legacy file in cwd. Paths remain literal (spaces work without shell quoting), and may also name other Markdown files inside the project.

1. Read the source without changing it. If it already satisfies the Markdown format and current word limits, no model call is needed.
2. Otherwise, use the **currently selected model** to normalize/shorten an in-memory draft. Validate it automatically; if invalid, send the same model the original source, latest draft and all numbered lesson-validation errors for **up to two correction passes** (three calls total). The whole drafting sequence is cancellable and shares a two-minute deadline. Source and correction-input drafts are each limited to 64 KiB; oversized invalid drafts need manual editing instead. There are no background requests or automatic retries of failed/incomplete model calls. The model is asked to shorten overlong lessons itself, keep valid lessons unchanged, and retain essential actions, commands, conditions and exceptions without splitting source items. With no model selected, a manual draft editor opens instead. For sources in the supported list format, code rejects any draft with a different lesson count, including manual edits; sources with more than 500 items need smaller files, not merged lessons. A draft still invalid after automatic correction offers **Cancel** or **Edit draft**, retaining the last rejected text. Manual edits do not restart automatic model calls. Model failures, incomplete responses and invalid drafts save nothing. Matching counts do not guarantee preserved meaning or order; review the wording.
3. Show a numbered **Before/After preview**, including the source path, database and project destination. For lesson lists, the summary shows source and proposed counts. Each changed lesson places its complete original immediately above the proposed wording, with word counts; unchanged lessons appear once, labelled **Unchanged**. Titles, list markers and surrounding blank lines are not lesson text. For mixed prose or unsupported Markdown, no reliable lesson pairing is assumed: show the complete original source followed by every numbered proposal. In the TUI, scroll with the configured selection arrows/page keys; Enter continues to approval, not to saving. RPC clients receive the complete preview through the editor dialog and must return it unchanged to continue. Control characters are displayed as escapes. Draft editors also escape control characters and warn that edited escapes become literal text; they never render raw terminal commands from a rejected draft.
4. Choose **Cancel**, **Edit draft**, or **Import N reviewed lessons**. Editing always returns through validation to a fresh preview. Cancel is the default. No lessons are written until import is explicitly approved.
5. Commit the whole validated batch atomically. A pre-commit check rejects changed source content, identity or location; a session/project/configuration reload cancels pending work. This saves the **approved snapshot**, not later filesystem edits. Atomicity applies to SQLite, not a cross-process filesystem/database transaction; unrelated writers are not locked out. Reports include IDs and both the original-source and normalized-draft SHA-256 hashes. Import completion reports are not clipped, so all IDs remain visible even for 500 lessons. Exact duplicates are skipped; archived duplicates stay archived.

**The source file is always kept unchanged.** Imports never move or delete it, offer no removal dialog, and create no source backups.

Then verify with `/memory list` or `/memory get <id>`. Legacy `MEMORY.md` files in cwd continue to be recalled alongside database lessons. Existing conversation text cannot be withdrawn from a model.

The final draft format is an optional `# Title`, then top-level `-`, `*`, `+`, or numbered list items, with continuations indented by at least two spaces. Unsupported prose/section headings require normalization rather than silent dropping. Imports are limited to 500 lessons and 1 MiB. Import evidence records the original file hash, not a claim of newly verified behavior. The low-level `importMarkdown` storage API remains noninteractive; the Pi command owns the review/approval workflow.

Import/export paths must be inside the current project after symlink resolution. Export refuses existing paths, including symlinks. Exports contain active lesson text only, not provenance, archived records, or revision history; they are human-readable snapshots, **not database backups**. For a full backup, use SQLite's backup API/command or close all connections before copying; copying only a live database file can omit WAL data.

## Architecture

- `src/store.ts`: harness-neutral schema, transactions, deduplication, revision checks.
- `src/project.ts`: canonical flat project scope.
- `src/config.ts`: storage path and limit configuration, with the adapter supplying the config directory.
- `src/limits.ts`: shared defaults and validation for word limits and recall count.
- `src/presentation.ts`: byte-bounded recall and result pagination.
- `src/operations.ts`: harness-neutral tool operations.
- `src/markdown.ts`: bounded source snapshots, import validation/commit, export.
- `src/legacy.ts`: cwd-only legacy discovery and bounded context.
- `src/import-review.ts`: boundary-preserving draft generation, Before/After viewer, manual repair and import approval.
- `src/index.ts`: Pi lifecycle, tool and command adapter.

Schema version 2 uses a `lessons` table with scope, text, evidence, capture basis, source harness/session, timestamps, revision and archive state. Version 1 databases upgrade atomically on open to accept `validated_learning`, preserving existing lessons and metadata. Older pi-mem releases cannot open version 2; reload all Pi sessions after upgrading. An application ID prevents accidentally initializing an unrelated database; unknown schema versions are rejected. WAL, a two-second busy timeout and immediate transactions support multiple local Pi processes. There is no daemon. Connections open only when a session starts or an operation needs them, and close on shutdown/reload.

Another harness can reuse the storage/operation modules and supply its own lifecycle/tool adapter. No other harness integration is included yet.

## Development and validation

The development dependencies pin the tested Pi version; no global Pi installation is needed for tests. On Linux, install Git, `xvfb` and `xauth`, then run from this checkout:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm audit
```

`npm test` runs strict TypeScript checking, core tests, and Pi integration tests. UI/protocol checks run under `xvfb-run`. CI repeats these checks on Node 22.19.0 and Node 24, with pinned GitHub Actions and read-only repository permissions.

Tests use disposable databases/projects in the OS temporary directory, not the real memory store. Core tests cover persistence, duplicate/archive behavior, scope matching, concurrent processes and stale revisions, byte budgets, database-path selection, schema upgrades, and migration safety. The loader smoke exercises Pi's real jiti loader and registered lifecycle handlers/tools with a test context, including legacy recall, a mocked shortening model, bounded automatic corrections with numbered validation feedback, lesson-count checks, manual fallback, Before/After cards, explicit approval, stale-source/session rejection, source retention without cleanup dialogs or backups, and preview scrolling/remapped keys. The RPC smoke starts real, isolated, offline Pi processes and verifies command saves, new-session recall, process-restart persistence, project isolation, and the import review/approval protocol without inherited credentials or model calls. Neither test claims to validate live-model capture decisions or full interactive-terminal rendering.

Local database files, credentials, runtime configuration, logs and workspace memory files are excluded from Git. The package's file allowlist includes only source and documentation.

## License and distribution

No open-source license has been selected. This repository is public, but no additional license grant is implied. The manifest is marked `UNLICENSED` and `private` to prevent accidental npm publication; installation from Git or a local path remains supported.
