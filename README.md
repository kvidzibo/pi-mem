# pi-mem

SQLite-backed project memory for Pi. Active lessons are recalled automatically; the agent can only **add**, **supersede**, or **archive** them. Replacements preserve old records rather than overwriting them. There is no restore or delete operation.

No transcript harvesting, embeddings, or background model calls. An explicit Markdown import may use the selected model to prepare a draft for approval.

## Setup

Requires Pi **0.85.1+** (tested with 0.85.1), Node **22.19+**, and Git for repository scoping.

```bash
pi install git:github.com/kvidzibo/pi-mem
```

For a local checkout, use `pi install /absolute/path/to/pi-mem`. Append `@<tag-or-commit>` to the Git source to pin a version. Load the package once through `packages`, not also through `extensions`, then run `/reload` in existing Pi sessions.

Capture timing belongs to your agent's rules; this package does not change them. Configure selective saves of verified, reusable lessons during authorized work, or explicitly ask the agent to remember a lesson.

## Usage

The agent's `memory` tool exposes only:

- **`add`** — save `text`, `evidence`, and `basis` (`validated_learning`, `validated_fix`, or `user_request`).
- **`supersede`** — supply an active lesson's `id` and the new lesson fields. Creating the linked replacement and archiving its predecessor succeed together or neither does.
- **`archive`** — supply `id` to exclude that record from future recall while retaining its content and provenance.

There are no agent read/search/history actions. An archived record cannot be superseded or restored. Adding the same normalized text as an active lesson returns its existing ID; adding archived wording creates a new record. Superseding rejects text already held by another active lesson without changing either record.

Human commands remain available:

| Command | Purpose |
|---|---|
| `/memory` | Show database path, project scope, and loaded lessons |
| `/memory add <lesson>` | Save a lesson explicitly |
| `/memory supersede <id> <lesson>` | Create a replacement and archive the original |
| `/memory archive <id>` | Archive without deleting |
| `/memory list [offset]` | Page through active lessons |
| `/memory archived [offset]` | Page through archived records |
| `/memory search <text>` | Search active text/evidence by literal substring |
| `/memory get <id>` | Inspect a retained record and its predecessor link |
| `/memory import [path]` | Review and approve a Markdown import |
| `/memory export <new-path>` | Export active lesson text without overwriting a file |
| `/memory reload` | Reread configuration and reconnect; also retries initialization failures |
| `/memory help` | Show command help |

Use full IDs from recall or inspection commands. List/archived pages return `nextOffset`; pages are capped at 30 records and 16 KiB. Search returns one bounded page, with SQLite's ASCII case-insensitive matching.

`--no-session` still recalls memory. Agent writes in ephemeral sessions require `basis: "user_request"`; explicit user commands remain available.

## Configuration and recall

Defaults, in `<Pi agent directory>/pi-mem.json` (normally `~/.pi/agent/pi-mem.json`):

```json
{
  "databasePath": "memory.sqlite3",
  "maxLessonWords": 20,
  "maxEvidenceWords": 20,
  "maxRecallLessons": 30
}
```

`PI_MEMORY_DB` overrides the database path. Relative paths resolve against the Pi agent directory, **not the project**; `~` expands to the home directory and `PI_CODING_AGENT_DIR` is respected. Project-local configuration cannot redirect storage. Changing paths selects another store; it does not move data. Run `/memory reload` after configuration changes.

Limits must be positive safe integers. Words are whitespace-separated; overlong saves fail rather than truncate. Text/evidence also have hard caps of 1,200/600 characters. Lowering limits does not rewrite existing lessons.

- **Scope:** the canonical Git worktree root, or canonical cwd outside Git. Subdirectories share a worktree's lessons; separate worktrees/clones remain separate. There is no global or parent-project inheritance. Scope follows Pi's cwd, not a shell tool's `cd`.
- **Recall:** refreshed before each model request, including after compaction and other sessions' writes. Active lessons load newest-created first, with stable ID tie-breaking, up to `maxRecallLessons` or **8 KiB**, whichever fills first. Omitted lessons stay stored but are unavailable to the agent on demand.
- **Archiving:** changes future database recall only. It cannot erase text already present elsewhere in a conversation or sent to a model.

## Legacy files and imports

A case-insensitive `MEMORY.md` in Pi's **current directory** is recalled separately, with a migration warning and a **32 KiB** context cap. No parent/child directory search or automatic import occurs.

```text
/memory import MEMORY.md
```

Imports require TUI or RPC dialogs. Review the Before/After preview, then approve, edit, or cancel. If normalization or shortening is needed, the selected model prepares a draft; with no model selected, use the manual editor. Invalid or rejected drafts save nothing. **The source file always stays unchanged.**

The supported format is an optional title followed by top-level bullets or numbered lessons, with continuations indented by two spaces. Imports accept at most **500 lessons / 1 MiB**; automatic drafting is limited to **64 KiB** sources. Larger sources need a smaller file or a prepared, valid draft. Import/export paths are literal paths relative to Pi's cwd, must stay inside the project after symlink resolution, and may contain spaces.

Imported `MEMORY.md` files continue to be recalled until you move or rename them yourself. They are not synchronized with database edits or archives. Active duplicate text is skipped during import; archived matches create new active records without changing the old ones.

## Privacy, backups, and upgrades

- Store no secrets or raw transcripts. SQLite storage is local and newly created database files are private (`0600`), but **not encrypted**. Recalled lessons, legacy text, and project paths go to the selected model, including hosted providers. Import drafting sends source text to that model. Print/JSON command reports can persist in session history and later model context.
- Use a **local filesystem with SQLite WAL support**, not a concurrently accessed network share. Markdown exports contain active text only and are **not database backups**. Use SQLite's backup API/command, or close all connections before copying; copying only a live database file can omit WAL data.
- **Back up before upgrading.** Schema v1/v2 databases upgrade automatically to **v3** on open, retaining existing records and metadata. Previously overwritten content cannot be recovered. Older releases cannot open v3: keep v3-capable code or a compatible backup for rollback, and `/reload` all Pi sessions after upgrading.

## Development and validation

On Linux, install Git, `xvfb`, and `xauth`, then run:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm audit
```

`npm test` runs TypeScript checks, storage tests, and Pi loader/RPC integration tests. UI/protocol checks use `xvfb-run`; tests use disposable databases and no live-model calls.

## License

No open-source license has been selected. The package is `UNLICENSED` and `private`; installation from Git or a local path remains supported.
