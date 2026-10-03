import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { estimateTokens, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { memoryConfig } from "./config.ts";
import { Backups, backupReport } from "./backups.ts";
import { auditChanges, auditReview, buildAudit, stagedAudit, writeAudit } from "./audit.ts";
import { menuChoice } from "./menu-ui.ts";
import { memoryMenu, type MenuState } from "./menu.ts";
import { ACTIONS, parseLessonId, runMemory, type MemoryRequest } from "./operations.ts";
import { boundedPage, clipped, formatTokens, globalRecallBytes, memoryContext, RESULT_BYTES, visible } from "./presentation.ts";
import { moveDestination, projectScope } from "./project.ts";
import { CONTEXT_TYPE, RecallContext, type RecallSnapshot } from "./recall.ts";
import { checkedPriority, DEFAULT_PRIORITY, GLOBAL_SCOPE, MAX_EVIDENCE, MAX_TEXT, MemoryStore, type AuditSnapshot, type Lesson, type Origin } from "./store.ts";

type SavedLesson = Pick<Lesson, "id" | "text" | "supersedes_id">;
type ArchivedLesson = Pick<Lesson, "id" | "text" | "scope"> & { session: string; database: string; audit?: boolean };
const SAVED_TYPE = "pi-mem-saved";
const ARCHIVED_TYPE = "pi-mem-archived";
const BACKUP_TYPE = "pi-mem-backup-report";
const COMMANDS = ["global", "list", "search", "get", "history", "add", "supersede", "priority", "move", "archive", "archived", "audit", "reload", "help"];
const HELP = [
  "/pi-mem — open the memory menu (text status without UI)",
  "/pi-mem global add|list|archived|search … — manage global lessons; ID commands resolve project or global lessons",
  "/pi-mem list [offset] | archived [offset] | search <text> | get <id>",
  "/pi-mem add [--priority 0–10] <lesson> | supersede <id> [--priority 0–10] <lesson> | archive <id>",
  "/pi-mem priority <id> <0–10> — change priority without replacing lesson content",
  "/pi-mem history <id> [offset] — inspect retained activity and attribution",
  "/pi-mem move <id> <destination-path|--global|--project> — move lesson and linked history; --project means current project; preserve IDs",
  "/pi-mem audit [--all-projects] [--file <path>] — agent proposal with Apply all / Cancel; file export is recommendations only",
  "/pi-mem audit cancel — discard a pending audit or close its approval dialog",
  "/pi-mem reload — reconnect and reread database configuration",
].join("\n");

export default function memoryExtension(pi: ExtensionAPI) {
  let state: MenuState | undefined;
  let failed: Error | undefined;
  let notified: string | undefined;
  let menu: AbortController | undefined;
  let generation = 0;
  let auditController: AbortController | undefined;
  let auditTurnBlocked = false;
  let backupShown = false;
  let pendingAudit: { id: string; snapshot: AuditSnapshot; state: MenuState; generation: number; session: string; cwd: string; anchor: string | null } | undefined;
  const recallContext = new RecallContext();

  function reset() {
    generation++;
    pendingAudit = undefined;
    menu?.abort(new Error("Session or memory configuration changed; menu closed"));
    state?.store.close();
    state = undefined;
    failed = undefined;
    notified = undefined;
  }

  function current(ctx: ExtensionContext) {
    if (failed) throw failed;
    try {
      if (!state) {
        const scope = projectScope(ctx.cwd);
        const { databasePath: path, ...limits } = memoryConfig(getAgentDir());
        state = { store: new MemoryStore(path, limits), path, scope, cwd: ctx.cwd, limits };
      } else if (state.cwd !== ctx.cwd) {
        state.scope = projectScope(ctx.cwd);
        state.cwd = ctx.cwd;
      }
      return state;
    } catch (error) {
      failed = error instanceof Error ? error : new Error(String(error));
      throw failed;
    }
  }

  function origin(ctx: ExtensionContext, toolCallId?: string): Origin {
    // Use the assistant that issued this call, not a potentially changed selected model.
    const entry = toolCallId === undefined ? undefined : ctx.sessionManager.getBranch().slice().reverse().find((entry) =>
      entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId));
    const message = entry?.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
    return { harness: "pi", session: ctx.sessionManager.getSessionId(),
      actor: toolCallId === undefined ? "user" : "model",
      provider: message?.provider ?? null, model: message?.model ?? null };
  }

  function sessionArchives(ctx: ExtensionContext, database: string, scope: string) {
    const ids = new Set<number>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== ARCHIVED_TYPE) continue;
      const data = entry.data as ArchivedLesson | undefined;
      if (data?.session === ctx.sessionManager.getSessionId() && data.database === database && data.scope === scope &&
          Number.isSafeInteger(data.id) && data.id > 0) ids.add(data.id);
    }
    return ids.size;
  }

  function snapshot(ctx: ExtensionContext) {
    const { store, path, scope, limits } = current(ctx);
    const page = store.recall(scope);
    const project = memoryContext(page, limits.maxRecallBytes);
    const globalPage = store.recall(GLOBAL_SCOPE);
    const global = memoryContext(globalPage, globalRecallBytes(limits.maxRecallBytes), "GLOBAL LESSONS");
    const result = {
      text: globalPage.total ? `${global.text}\n\n${project.text}` : project.text,
      loaded: project.loaded + global.loaded,
      loadedIds: [...global.loadedIds, ...project.loadedIds],
      lessons: [...global.lessons, ...project.lessons],
      notices: [
        ...(globalPage.total > global.loaded ? [`GLOBAL LESSONS: ${globalPage.total - global.loaded} lessons omitted.`] : []),
        ...(page.total > project.loaded ? [`PROJECT LESSONS: ${page.total - project.loaded} lessons omitted.`] : []),
      ],
    };
    if (ctx.hasUI) {
      const tokens = estimateTokens({ role: "custom", customType: CONTEXT_TYPE, content: result.text, display: false, timestamp: 0 });
      const projectChanges = store.sessionCreations(scope, origin(ctx));
      const globalChanges = store.sessionCreations(GLOBAL_SCOPE, origin(ctx));
      const added = projectChanges.added + globalChanges.added;
      const archived = projectChanges.superseded + globalChanges.superseded +
        sessionArchives(ctx, path, scope) + sessionArchives(ctx, path, GLOBAL_SCOPE);
      const changes = [added ? `+${added}` : "", archived ? `-${archived}` : ""].filter(Boolean).join(" ");
      const count = `${project.loaded}|${global.loaded}`;
      // Pi trims each status; ANSI reset guards preserve the surrounding visible spaces.
      ctx.ui.setStatus("pi-mem", `\x1b[0m 🧠 ${count}${changes ? ` (${changes})` : ""} ~${formatTokens(tokens)} \x1b[0m`);
    }
    notified = undefined;
    return result;
  }

  function unavailable(error: unknown, ctx: ExtensionContext): string {
    const message = clipped(String(error instanceof Error ? error.message : error), 700);
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-mem", "\x1b[0m 🧠 unavailable \x1b[0m");
      if (message !== notified) ctx.ui.notify(`Memory unavailable: ${message}. /pi-mem reload retries.`, "warning");
    }
    notified = message;
    return `Project memory unavailable: ${JSON.stringify(message)}. No SQLite lessons were loaded. /pi-mem reload retries.`;
  }

  function show(value: unknown, ctx: ExtensionContext) {
    const text = clipped(typeof value === "string" ? value : JSON.stringify(value, null, 2), RESULT_BYTES);
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-mem-report", content: text, display: true });
  }

  function sendAudit(allProjects: boolean, ctx: ExtensionContext) {
    if (menu) throw new Error("Close the memory review before starting another audit");
    const value = current(ctx);
    const id = randomUUID();
    const audit = { id, snapshot: value.store.auditSnapshot(value.scope, allProjects), state: value,
      generation, session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, anchor: ctx.sessionManager.getLeafId() };
    pendingAudit = audit;
    auditTurnBlocked = true;
    // Deliberate model-visible audit; the menu has closed before dispatch. Never parse a Markdown reply.
    pi.sendMessage({ customType: "pi-mem-audit", content: stagedAudit(audit.snapshot, id), display: true },
      { triggerTurn: true, deliverAs: "followUp" });
  }

  function recordSaved(ids: number[], ctx: ExtensionContext) {
    if (!ids.length) return;
    try {
      const { store, scope } = current(ctx);
      const lessons: SavedLesson[] = ids.map((id) => {
        const { text, supersedes_id } = store.get(store.scopeForId(scope, id), id);
        return { id, text, supersedes_id };
      });
      // Durable chat-only entries: no extra model context, steering, or agent turn.
      pi.appendEntry<SavedLesson[]>(SAVED_TYPE, lessons);
    } catch (error) {
      // A display failure must never turn an already-committed save into a reported write failure.
      if (ctx.hasUI) ctx.ui.notify(`Memory saved, but chat entry failed: ${clipped(String(error), 700)}`, "warning");
    }
  }

  function recordArchived(id: number, ctx: ExtensionContext, audit = false) {
    try {
      const { store, path, scope: project } = current(ctx);
      const scope = store.scopeForId(project, id);
      const { text } = store.get(scope, id);
      // Audit entries remain durable for footer counts but do not render chat cards.
      pi.appendEntry<ArchivedLesson>(ARCHIVED_TYPE, { id, text, scope, database: path, session: ctx.sessionManager.getSessionId(),
        ...(audit ? { audit: true } : {}) });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Memory archived, but chat entry failed: ${clipped(String(error), 700)}`, "warning");
    }
  }

  function recordWrite(result: ReturnType<typeof runMemory>, ctx: ExtensionContext) {
    if (result.status === "saved" || result.status === "superseded") recordSaved([result.id], ctx);
    if (result.changed) recordArchived(result.id, ctx);
    return result;
  }

  pi.registerEntryRenderer<SavedLesson[]>(SAVED_TYPE, (entry, _options, theme) => {
    const lessons = entry.data ?? [];
    const replaced = lessons.filter((lesson) => lesson.supersedes_id !== null).length;
    const heading = theme.fg("success", `Memory ${replaced ? "replaced" : "added"} (+${lessons.length}${replaced ? ` -${replaced}` : ""})`);
    const lines = lessons.map((lesson) => `#${lesson.id}${lesson.supersedes_id ? ` (replaces #${lesson.supersedes_id})` : ""}: ${visible(lesson.text)}`);
    return new Text([heading, ...lines].join("\n"), 1, 1, (text) => theme.bg("toolSuccessBg", text));
  });

  pi.registerEntryRenderer<ArchivedLesson>(ARCHIVED_TYPE, (entry, _options, theme) => {
    const lesson = entry.data;
    if (lesson?.audit) return undefined;
    return new Text(lesson ? `${theme.fg("warning", "Memory archived (-1)")}\n#${lesson.id}: ${visible(lesson.text)}` : "", 0, 0);
  });

  function recall(ctx: ExtensionContext): string {
    try { return snapshot(ctx).text; } catch (error) { return unavailable(error, ctx); }
  }

  async function openMenu(ctx: ExtensionContext) {
    if (menu) throw new Error("A memory menu is already open; close it first");
    while (true) {
      const controller = new AbortController();
      menu = controller;
      const started = generation;
      const cwd = ctx.cwd;
      const source = origin(ctx);
      const check = () => {
        controller.signal.throwIfAborted();
        if (generation !== started || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== source.session) {
          throw new Error("Session or project changed; memory menu closed");
        }
      };
      let action;
      try {
        action = await memoryMenu(ctx, {
          current: () => {
            check();
            const value = current(ctx);
            if (projectScope(cwd) !== value.scope) throw new Error("Project scope changed; reload memory before continuing");
            return value;
          },
          check, signal: controller.signal, origin: source, configPath: join(getAgentDir(), "pi-mem.json"), help: HELP,
          refresh: () => { try { snapshot(ctx); } catch (error) { unavailable(error, ctx); } },
          saved: (ids) => recordSaved(ids, ctx),
          archived: (id) => recordArchived(id, ctx),
        });
        check();
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      } finally {
        if (menu === controller) menu = undefined;
      }
      if (action && typeof action === "object") { sendAudit(action.audit.allProjects, ctx); return; }
      if (action !== "reload") return;
      reset();
      try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
    }
  }

  pi.on("session_start", async (event, ctx) => {
    recallContext.reset();
    reset();
    recall(ctx);
    backupShown = false;
    if (event.reason === "reload" && ctx.hasUI) {
      const entry = ctx.sessionManager.getBranch().slice().reverse().find((entry) => entry.type === "custom" && entry.customType === BACKUP_TYPE);
      const report = entry?.type === "custom" ? (entry.data as { text?: string | null })?.text : undefined;
      if (report) ctx.ui.setWidget("pi-mem-backup", report.split("\n"));
      backupShown = !!report;
    }
    if (event.reason !== "startup" || failed) return;
    const started = generation;
    const session = ctx.sessionManager.getSessionId();
    let report: string;
    try {
      const manager = new Backups(current(ctx).path);
      const info = await manager.create(true);
      if (!info) return;
      let total: number | undefined;
      try { total = manager.stats().bytes; } catch { /* Do not misreport a successful backup as failed. */ }
      report = backupReport(info, total);
    } catch (error) {
      report = `Memory backup failed: ${visible(clipped(error instanceof Error ? error.message : String(error), 700))}. Will retry at next startup.`;
    }
    if (generation !== started || ctx.sessionManager.getSessionId() !== session) return;
    // Widgets survive startup rendering; custom entries preserve the report across /reload without model context.
    pi.appendEntry(BACKUP_TYPE, { text: report });
    if (ctx.hasUI) {
      ctx.ui.setWidget("pi-mem-backup", report.split("\n"));
      backupShown = true;
    }
  });

  pi.on("input", (_event, ctx) => {
    if (backupShown) {
      ctx.ui.setWidget("pi-mem-backup", undefined);
      pi.appendEntry(BACKUP_TYPE, { text: null });
      backupShown = false;
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    recallContext.reset();
    reset();
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-mem", undefined);
      if (backupShown) ctx.ui.setWidget("pi-mem-backup", undefined);
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Only a fresh prompt releases the run-level barrier. Reload, navigation, compaction and automatic retries do not.
    if (!pendingAudit && !auditController && !menu) auditTurnBlocked = false;
    try {
      const { limits } = current(ctx);
      return { systemPrompt: event.systemPrompt + "\n\nFor memory add/supersede: save one actionable point, preferably one sentence. " +
        "Keep evidence to a short verification statement. Preserve essential commands and conditions; omit background, narration, repetition and filler. " +
        `Maximum ${limits.maxLessonWords} words per lesson and ${limits.maxEvidenceWords} words for evidence (whitespace-separated). ` +
        "These are ceilings, not targets. Overlong saves are rejected, not truncated." };
    } catch {
      // The context hook reports initialization failures without blocking the agent.
      return;
    }
  });

  const invalidateAudit = () => {
    pendingAudit = undefined;
    menu?.abort(new Error("Session branch changed; memory review cancelled"));
    recallContext.reset();
  };
  pi.on("session_compact", invalidateAudit);
  pi.on("session_tree", invalidateAudit);

  pi.on("context", (event, ctx) => {
    let recalled: RecallSnapshot;
    try { recalled = snapshot(ctx); } catch (error) {
      const text = unavailable(error, ctx);
      recalled = { text, lessons: [], notices: [text] };
    }
    return { messages: recallContext.apply(event.messages, recalled) };
  });

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: "Write project or global lessons. Active lessons are recalled automatically; no on-demand reads. " +
      "Choose global scope for cross-project lessons or unrelated CLI usage; otherwise use project (default). " +
      "ID-based actions retain scope and target only current-project or global lessons. " +
      "add/supersede require text, evidence, and basis: validated_learning for verified discoveries, validated_fix for corrections, " +
      "or user_request for explicit memory requests. Evidence describes the verification or explicit memory request. " +
      "supersede requires an active lesson id; it creates a replacement and archives the original atomically. archive requires id. " +
      "add and set_priority require priority, an integer from 1 (highest) to 10 (lowest). " +
      "set_priority requires an active lesson id and changes only its priority; models cannot reprioritize priority 0. " +
      "reason optionally records why a change was made in the retained activity log. " +
      "Score future usefulness by consequence of ignoring the lesson, likelihood of recurrence, and breadth of applicability. " +
      "1–2: serious damage or corruption; 3–4: recurring failures or expensive debugging; " +
      "5–6: useful recurring knowledge; 7–8: narrow quirks; 9–10: marginal future value. " +
      "supersede inherits priority unless supplied; priority 0 is user-reserved and preserved when superseding. " +
      "Lesson content is retained: supersede rather than edit it; no restore or delete. Exact active duplicates are not added. " +
      "No secrets or raw transcripts. In ephemeral sessions, writes require basis=user_request.",
    promptSnippet: "Add, supersede, archive, or reprioritize project and global lessons",
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      scope: Type.Optional(StringEnum(["project", "global"] as const, {
        description: "Scope for add only; defaults to project. ID-based actions retain the existing scope.",
      })),
      id: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER,
        description: "Stable lesson number from the #id suffix." })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
      evidence: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 600 })),
      basis: Type.Optional(StringEnum(["validated_learning", "validated_fix", "user_request"] as const)),
      priority: Type.Optional(Type.Integer({ minimum: 1, maximum: 10,
        description: "Required for add/set_priority; optional for supersede. 1 = highest priority, 10 = lowest. Zero is user-only." })),
    }),
    prepareArguments(args) {
      // Reject coercible values before Pi's schema validation (e.g. true becoming 1).
      if (args && typeof args === "object") {
        if ("priority" in args) checkedPriority(args.priority, 1);
        if ("id" in args && args.id != null) return { ...args, id: parseLessonId(args.id) } as MemoryRequest;
      }
      return args as MemoryRequest;
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (pendingAudit || menu || auditTurnBlocked) throw new Error("Memory review pending; submit the audit through memory_audit and await user approval");
      const { store, scope } = current(ctx);
      if (!ctx.sessionManager.getSessionFile() && params.basis !== "user_request") {
        throw new Error("Ephemeral sessions require an explicit user memory request for persistent writes");
      }
      const result = recordWrite(runMemory(store, scope, params, origin(ctx, _id)), ctx);
      // Saving succeeded even if a later status/recall refresh fails; report the commit accurately.
      try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "memory_audit",
    label: "Memory audit proposal",
    description: "Submit the complete structured proposal for a user-requested memory audit. Requires the auditId from the current audit export. " +
      "Only audited active IDs are allowed; never target priority 0. Actions: archive, set_priority (priority 1–10), move_global. " +
      "One action per ID, with a short reason. Empty changes means no warranted changes. " +
      "Nothing changes without the user's Apply all choice in the extension UI; Cancel changes nothing. " +
      "Approval applies the whole batch atomically across audited scopes, rejecting stale lessons or duplicate destinations. " +
      "Do not apply audit changes through memory or shell commands.",
    parameters: Type.Object({
      auditId: Type.String({ minLength: 1, maxLength: 80 }),
      changes: Type.Array(Type.Union([
        Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), action: Type.Literal("archive"),
          reason: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
        Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), action: Type.Literal("set_priority"),
          priority: Type.Integer({ minimum: 1, maximum: 10 }), reason: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
        Type.Object({ id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), action: Type.Literal("move_global"),
          reason: Type.String({ minLength: 1, maxLength: 600 }) }, { additionalProperties: false }),
      ]), { maxItems: 10000 }),
    }, { additionalProperties: false }),
    prepareArguments(args) {
      if (!args || typeof args !== "object" || !("auditId" in args) || typeof args.auditId !== "string") {
        throw new Error("auditId must be a string from the current audit");
      }
      if (Object.keys(args).some((key) => !["auditId", "changes"].includes(key))) throw new Error("Unexpected audit proposal field");
      return { auditId: args.auditId, changes: auditChanges("changes" in args ? args.changes : undefined) };
    },
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const audit = pendingAudit;
      if (!audit || audit.id !== params.auditId) throw new Error("No matching pending audit; start /pi-mem audit again");
      if (!ctx.hasUI) throw new Error("Audit approval requires interactive or RPC UI; no memories changed");
      if (menu) throw new Error("A memory menu is already open; close it first");
      const changes = auditChanges(params.changes, audit.snapshot);
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const check = () => {
        controller.signal.throwIfAborted();
        if (audit.generation !== generation || ctx.cwd !== audit.cwd || ctx.sessionManager.getSessionId() !== audit.session ||
            current(ctx) !== audit.state || projectScope(ctx.cwd) !== audit.snapshot.project ||
            (audit.anchor && !ctx.sessionManager.getBranch().some((entry) => entry.id === audit.anchor))) {
          throw new Error("Session, project, or memory configuration changed; start a new audit");
        }
      };
      const result = (status: string, data = {}) => ({ content: [{ type: "text" as const, text: JSON.stringify({ status, ...data }) }],
        details: { status, ...data } });
      try {
        check();
        // A proposal is one-shot. Session changes abort the review; a late approval cannot resurrect it.
        pendingAudit = undefined;
        if (!changes.length) return result("no changes");
        menu = controller;
        auditController = controller;
        const choice = await menuChoice(ctx, "Review memory audit", auditReview(audit.snapshot, changes),
          [{ value: "cancel", label: "Cancel" }, { value: "apply", label: "Apply all" }], controller.signal);
        check();
        if (choice !== "apply") return result("cancelled", { message: "No memories changed" });
        // Attribution retains the proposing model, while actor=user records the explicit UI approval.
        const applied = audit.state.store.applyAudit(audit.snapshot, changes, { ...origin(ctx, _id), actor: "user" });
        for (const entry of applied) {
          if (entry.action === "archive" && (entry.from === audit.snapshot.project || entry.from === GLOBAL_SCOPE)) {
            try { recordArchived(entry.lesson.id, ctx, true); } catch { /* Committed writes remain successful if UI reporting fails. */ }
          }
        }
        try { snapshot(ctx); } catch { /* Recall will refresh on the next request; never misreport a committed batch. */ }
        return result("applied", { count: applied.length, changes: applied.map((entry) => ({ id: entry.lesson.id,
          action: entry.action, from: entry.from, scope: entry.lesson.scope, priority: entry.lesson.priority,
          ...(entry.moved === undefined ? {} : { records: entry.moved }) })) });
      } finally {
        signal?.removeEventListener("abort", abort);
        if (menu === controller) menu = undefined;
        if (auditController === controller) auditController = undefined;
      }
    },
  });

  pi.registerCommand("pi-mem", {
    description: "Open the project memory menu, or use lesson subcommands",
    getArgumentCompletions(prefix) {
      return COMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      try {
        let [command, rest] = firstWord(args);
        const globalCommand = command === "global";
        if (globalCommand) {
          [command, rest] = firstWord(rest);
          if (!["add", "list", "archived", "search"].includes(command)) {
            throw new Error("Usage: /pi-mem global add|list|archived|search …; use IDs directly for other actions");
          }
        }
        if (command === "help") { show(HELP, ctx); return; }
        if (!command && ctx.hasUI) { await openMenu(ctx); return; }
        if (command === "reload") reset();
        const { store, path, scope: project } = current(ctx);
        let scope = globalCommand ? GLOBAL_SCOPE : project;
        if (["get", "history", "move", "priority", "supersede", "archive"].includes(command)) {
          scope = store.scopeForId(project, parseLessonId(firstWord(rest)[0]));
        }
        const source = origin(ctx);
        if (!command || command === "reload") {
          show(`Database: ${JSON.stringify(path)}\n${recall(ctx)}`, ctx);
          return;
        }
        if (command === "audit") {
          if (rest.trim() === "cancel") {
            pendingAudit = undefined;
            auditController?.abort(new Error("Audit cancelled; no memories changed"));
            show("Audit cancelled; no memories changed.", ctx);
            return;
          }
          let [flag, tail] = firstWord(rest);
          const allProjects = flag === "--all-projects";
          if (allProjects) [flag, tail] = firstWord(tail);
          if ((flag && flag !== "--file") || (flag === "--file" && !tail)) {
            throw new Error("Usage: /pi-mem audit [--all-projects] [--file <new-file-path>]");
          }
          if (flag === "--file") show(`Audit exported to ${JSON.stringify(writeAudit(ctx.cwd, tail, buildAudit(store, project, allProjects)))}. No memories changed.`, ctx);
          else sendAudit(allProjects, ctx);
        } else if (command === "list" || command === "archived") {
          const offset = rest ? Number(rest) : 0;
          show(boundedPage(store.list(scope, { state: command === "archived" ? "archived" : "active", offset }), offset), ctx);
        } else if (command === "search") {
          if (!rest.trim()) throw new Error("search requires query");
          show(boundedPage(store.list(scope, { query: rest }), 0), ctx);
        } else if (command === "get") {
          show(store.get(scope, parseLessonId(rest)), ctx);
        } else if (command === "history") {
          const [id, offset] = firstWord(rest);
          const start = offset ? Number(offset) : 0;
          const page = store.history(scope, parseLessonId(id), start, 5);
          while (Buffer.byteLength(JSON.stringify(page, null, 2)) > RESULT_BYTES && page.events.length > 1) {
            page.events.pop();
            page.nextOffset = start + page.events.length;
          }
          if (Buffer.byteLength(JSON.stringify(page, null, 2)) > RESULT_BYTES) {
            throw new Error("Activity metadata exceeds the command output limit; use the History menu");
          }
          show(page, ctx);
        } else if (command === "move") {
          const [value, destination] = firstWord(rest);
          if (!destination) throw new Error("Usage: /pi-mem move <id> <destination-path|--global|--project>");
          const id = parseLessonId(value);
          const to = destination === "--global" ? GLOBAL_SCOPE
            : destination === "--project" ? project : moveDestination(ctx.cwd, destination).scope;
          const moved = store.moveLesson(scope, id, to, source);
          show({ id, status: "moved", records: moved, from: scope, to }, ctx);
        } else if (command === "priority") {
          const [id, value] = firstWord(rest);
          if (!/^(?:[0-9]|10)$/.test(value)) throw new Error("Usage: /pi-mem priority <id> <0–10>");
          const lesson = store.setPriority(scope, parseLessonId(id), Number(value), source);
          show({ id: lesson.id, priority: lesson.priority, status: "priority updated", scope }, ctx);
        } else if (command === "add" || command === "supersede") {
          const [id, body] = command === "supersede" ? firstWord(rest) : ["", rest];
          const { text, priority } = commandLesson(body);
          const input = { text, priority: command === "add" ? priority ?? DEFAULT_PRIORITY : priority,
            basis: "user_request" as const, evidence: "User-requested." };
          if (command === "add") {
            const result = store.add(scope, input, source);
            show(recordWrite({ id: result.lesson.id, priority: result.lesson.priority,
              status: result.created ? "saved" : "already exists", scope }, ctx), ctx);
          } else {
            const result = store.supersede(scope, parseLessonId(id), input, source);
            show(recordWrite({ id: result.id, priority: result.priority, supersedes_id: result.supersedes_id,
              status: "superseded", scope }, ctx), ctx);
          }
        } else if (command === "archive") {
          show(recordWrite(runMemory(store, scope, { action: "archive", id: parseLessonId(rest) }, source), ctx), ctx);
        } else {
          throw new Error(HELP);
        }
        try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (ctx.hasUI) ctx.ui.notify(clipped(message, RESULT_BYTES), "error");
        else throw error;
      }
    },
  });
}

function commandLesson(value: string): { text: string; priority?: number } {
  const [flag, rest] = firstWord(value);
  if (flag !== "--priority") return { text: value };
  const [score, text] = firstWord(rest);
  if (!/^(?:[0-9]|10)$/.test(score)) throw new Error("--priority requires an integer from 0 to 10");
  return { text, priority: checkedPriority(Number(score)) };
}

function firstWord(value: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(value.trim());
  return match ? [match[1], match[2]] : ["", ""];
}
