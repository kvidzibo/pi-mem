# pi-mem

SQLite-backed project lessons for Pi. Recall is automatic; saving is selective and agent-driven. No background model calls, embeddings, transcript harvesting, or `MEMORY.md` fallback.

## Setup

Requires Pi **0.85.1 or later**, Git for repository scoping, and Node **22.19+** with `node:sqlite`. Pi 0.85.1 is the tested version. Node 22 prints an experimental SQLite warning. Pi supplies the peer dependencies; there are no additional runtime dependencies.

```bash
pi install git:github.com/kvidzibo/pi-mem
```

For a local checkout, use `pi install /absolute/path/to/pi-mem` instead. Load the package once, through `packages`, not also through `extensions`. Run `/reload` in existing Pi sessions afterward. Installing changes Pi settings, not your agent instruction files.

Capture timing belongs to the agent's rules: after fixing a failed attempt, save one validated reusable lesson during an authorized workspace-write task, or save on an explicit user memory request. The package does not rewrite agent rules. An agent without that policy can still use the memory tool and commands, but selective automatic capture is not guaranteed.

## Database path

Precedence:

1. `PI_MEMORY_DB` environment variable.
2. `databasePath` in `<Pi agent directory>/pi-mem.json`.
3. `<Pi agent directory>/memory.sqlite3` (normally `~/.pi/agent/memory.sqlite3`).

Example extension configuration, normally `~/.pi/agent/pi-mem.json`:

```json
{
  "databasePath": "~/.local/share/pi-mem/lessons.sqlite3"
}
```

Or launch Pi with:

```bash
PI_MEMORY_DB=/absolute/path/lessons.sqlite3 pi
```

`~` expands to the home directory. Relative database paths resolve against the **Pi agent directory**, never the project cwd. `PI_CODING_AGENT_DIR` is respected. Project-local configuration cannot redirect the database. Empty paths and malformed configuration fail visibly rather than silently selecting another database. An explicit environment override takes precedence even if the config file is invalid.

Use `/memory reload` after changing the path. Changing paths selects a different store; it does not move or copy lessons. Use a local filesystem that supports SQLite WAL locking, not a concurrently accessed network share.

## Scope and recall

- **Inside Git:** the canonical worktree root is the scope. Every subdirectory shares it.
- **Outside Git:** the canonical cwd is the scope. Unrelated directories do not inherit lessons.
- Symlink aliases resolve to the same scope. Separate worktrees/clones stay separate.
- No global, parent, or per-subdirectory inheritance. Renaming/moving a project does not automatically remap its lessons.
- Scope follows Pi's `ctx.cwd`, not `cd` inside an individual shell command.

At session start (including new/resumed/forked/reloaded sessions), the extension opens the database and loads the current scope. Before each model request it rereads committed lessons and injects one replaceable reference-data block. This survives compaction, reflects other sessions' writes, and does not append repeated memory messages to session history.

Recall includes at most **30 active lessons and 8 KiB**, newest-updated first with stable ID tie-breaking. Older/excess lessons stay in SQLite and can be searched. The status indicator shows loaded/total counts. Archiving removes a lesson from future recall; it cannot erase text already present elsewhere in a conversation or previously sent to a model.

Initialization failures are reported in the UI and model context without preventing Pi from running. `/memory reload` retries. Tool write failures are errors, never success messages.

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
| `/memory import <path>` | Explicit, atomic Markdown migration; retain source |
| `/memory export <new-path>` | Export active lesson text to a new Markdown file |
| `/memory reload` | Reconnect and reread extension configuration |
| `/memory help` | Command reference |

Use full IDs from list/search. Command arguments after `import`/`export` are literal paths relative to Pi's cwd; spaces work without shell quoting. Commands are primarily for the TUI/RPC UI. The `memory` tool works in noninteractive modes too.

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

- `add`/`update` require text, evidence, and `basis`: `validated_fix` or `user_request`.
- Text is limited to 1,200 characters; evidence to 600. Control characters are rejected.
- Evidence records what the agent/user asserts was verified. The extension cannot independently prove the lesson or infer task authorization.
- `update`/`archive`/`restore` require the current `revision`. A concurrent change fails rather than overwriting newer data; fetch the lesson again before retrying.
- Whitespace/Unicode-normalized exact duplicates return their existing IDs. This is not semantic deduplication. Adding an archived duplicate does not restore it.
- Updates replace the previous text; revisions detect conflicts, **not** retained edit history. Archive/restore is reversible.
- `list`/`search` accept `state` (`active`, `archived`, `all`), `offset`, and `limit` (1–30). Results are capped at 16 KiB with `nextOffset` for continuation. Search is a literal, case-insensitive substring match using SQLite's built-in lowercase behavior (ASCII case folding).
- `--no-session` still recalls memory. Persistent tool writes in ephemeral sessions require `basis: "user_request"`; explicit commands remain available.

No secrets, raw transcripts, or speculative fixes belong in memory. Recalled lessons are reference data, not authority to override task instructions or repository evidence. Storage is local and newly created databases are private (mode `0600`), but **not encrypted**. Recalled content goes to the selected model, including hosted providers, like other conversation context.

## Migrating existing MEMORY.md files

Nothing is scanned or imported automatically. From the appropriate project:

```text
/memory import MEMORY.md
/memory list
```

The accepted format is an optional `# Title`, then top-level `-`, `*`, `+`, or numbered list items. Continuations must be indented by two spaces. Unsupported prose/section headings are rejected rather than silently discarded; normalize them into self-contained lessons first. Imports are limited to 500 lessons and 1 MiB, validate the whole batch before writing, and report IDs plus the source SHA-256. Repeating an import does not add duplicates or reactivate archived lessons.

The source file is **never deleted by the command**. Verify the imported lessons before explicitly removing selected source files. There is no ongoing synchronization or Markdown fallback.

Import/export paths must be inside the current project after symlink resolution. Export refuses existing paths, including symlinks. Exports contain active lesson text only, not provenance, archived records, or revision history; they are human-readable snapshots, **not database backups**. For a full backup, use SQLite's backup API/command or close all connections before copying; copying only a live database file can omit WAL data.

## Architecture

- `src/store.ts`: harness-neutral schema, transactions, deduplication, revision checks.
- `src/project.ts`: canonical flat project scope.
- `src/config.ts`: configurable storage path, with the adapter supplying the config directory.
- `src/presentation.ts`: byte-bounded recall and result pagination.
- `src/operations.ts`: harness-neutral tool operations.
- `src/markdown.ts`: explicit import/export.
- `src/index.ts`: Pi lifecycle, tool and command adapter.

Schema version 1 uses a `lessons` table with scope, text, evidence, capture basis, source harness/session, timestamps, revision and archive state. An application ID prevents accidentally initializing an unrelated database; unknown schema versions are rejected. WAL, a two-second busy timeout and immediate transactions support multiple local Pi processes. There is no daemon. Connections open only when a session starts or an operation needs them, and close on shutdown/reload.

Another harness can reuse the storage/operation modules and supply its own lifecycle/tool adapter. No other harness integration is included yet.

## Development and validation

The development dependencies pin the tested Pi version; no global Pi installation is needed for tests. On Linux, install Git, `xvfb` and `xauth`, then run from this checkout:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm audit
```

`npm test` runs strict TypeScript checking, core tests, and Pi integration tests. UI/protocol checks run under `xvfb-run`. CI repeats these checks on Node 22.19.0 and Node 24, with pinned GitHub Actions and read-only repository permissions.

Tests use disposable databases/projects in the OS temporary directory, not the real memory store. Core tests cover persistence, duplicate/archive behavior, scope matching, concurrent processes and stale revisions, byte budgets, database-path selection, and migration safety. The loader smoke exercises Pi's real jiti loader and registered lifecycle handlers/tools with a test context. The RPC smoke starts real, isolated, offline Pi processes and verifies command saves, new-session recall, process-restart persistence, and project isolation without inherited credentials or model calls. Neither test claims to validate live-model capture decisions or full interactive-terminal rendering.

Local database files, credentials, runtime configuration, logs and workspace memory files are excluded from Git. The package's file allowlist includes only source and documentation.

## License and distribution

No open-source license has been selected. This repository is public, but no additional license grant is implied. The manifest is marked `UNLICENSED` and `private` to prevent accidental npm publication; installation from Git or a local path remains supported.
