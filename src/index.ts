import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { memoryConfig } from "./config.ts";
import type { MemoryLimits } from "./limits.ts";
import { exportMarkdown, exportPath } from "./markdown.ts";
import { reviewedImport } from "./import-review.ts";
import { legacyContext, legacyFiles } from "./legacy.ts";
import { ACTIONS, runMemory, type MemoryRequest } from "./operations.ts";
import { clipped, memoryContext, RESULT_BYTES } from "./presentation.ts";
import { projectScope } from "./project.ts";
import { MAX_EVIDENCE, MAX_TEXT, MemoryStore, type Origin } from "./store.ts";

const CONTEXT_TYPE = "pi-mem-context";
const COMMANDS = ["list", "search", "get", "add", "edit", "archive", "restore", "archived", "import", "export", "reload", "help"];
const HELP = [
  "/memory — database, project and loaded lessons",
  "/memory list [offset] | archived [offset] | search <text> | get <id>",
  "/memory add <lesson> | edit <id> <lesson> | archive <id> | restore <id>",
  "/memory import [path] — draft if needed, review diff, approve import; source always kept unchanged",
  "/memory export <new-path> — active lesson text, no overwrite",
  "/memory reload — reconnect and reread database configuration",
].join("\n");

export default function memoryExtension(pi: ExtensionAPI) {
  let state: { store: MemoryStore; path: string; scope: string; cwd: string; limits: Readonly<MemoryLimits> } | undefined;
  let failed: Error | undefined;
  let notified: string | undefined;
  let legacyNotified: string | undefined;
  let importing: AbortController | undefined;
  let generation = 0;

  function reset() {
    generation++;
    importing?.abort(new Error("Session or memory configuration changed; import cancelled"));
    importing = undefined;
    legacyNotified = undefined;
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

  function origin(ctx: ExtensionContext): Origin {
    return { harness: "pi", session: ctx.sessionManager.getSessionId() };
  }

  function snapshot(ctx: ExtensionContext) {
    const { store, scope } = current(ctx);
    const page = store.recall(scope);
    const result = memoryContext(scope, page);
    if (ctx.hasUI) ctx.ui.setStatus("pi-mem", `memory ${result.loaded}/${page.total}`);
    notified = undefined;
    return result;
  }

  function unavailable(error: unknown, ctx: ExtensionContext): string {
    const message = clipped(String(error instanceof Error ? error.message : error), 700);
    if (ctx.hasUI) {
      ctx.ui.setStatus("pi-mem", "memory unavailable");
      if (message !== notified) ctx.ui.notify(`Memory unavailable: ${message}. /memory reload retries.`, "warning");
    }
    notified = message;
    return `Project memory unavailable: ${JSON.stringify(message)}. No SQLite lessons were loaded. /memory reload retries.`;
  }

  function show(value: unknown, ctx: ExtensionContext) {
    const text = clipped(typeof value === "string" ? value : JSON.stringify(value, null, 2), RESULT_BYTES);
    if (ctx.hasUI) ctx.ui.notify(text, "info");
    else pi.sendMessage({ customType: "pi-mem-report", content: text, display: true });
  }

  function recall(ctx: ExtensionContext): string {
    const parts: string[] = [];
    try { parts.push(snapshot(ctx).text); } catch (error) { parts.push(unavailable(error, ctx)); }
    try {
      // Legacy recall does not depend on a working SQLite configuration.
      const scope = state?.cwd === ctx.cwd ? state.scope : projectScope(ctx.cwd);
      const legacy = legacyContext(scope, ctx.cwd);
      if (legacy.text) parts.push(legacy.text);
      const noticeKey = legacy.warning + legacy.text;
      if (legacy.warning && noticeKey !== legacyNotified) {
        if (ctx.hasUI) ctx.ui.notify(legacy.warning, "warning");
        else pi.sendMessage({ customType: "pi-mem-legacy-warning", content: legacy.warning, display: true }, { triggerTurn: false });
      }
      legacyNotified = noticeKey;
    } catch (error) {
      const warning = `Legacy memory unavailable: ${clipped(String(error instanceof Error ? error.message : error), 700)}`;
      parts.push(warning);
      if (warning !== legacyNotified && ctx.hasUI) ctx.ui.notify(warning, "warning");
      legacyNotified = warning;
    }
    return parts.join("\n\n");
  }

  pi.on("session_start", (_event, ctx) => {
    reset();
    recall(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    reset();
    if (ctx.hasUI) ctx.ui.setStatus("pi-mem", undefined);
  });

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const { limits } = current(ctx);
      return { systemPrompt: event.systemPrompt + "\n\nFor memory add/update: save one actionable point, preferably one sentence. " +
        "Keep evidence to a short verification statement. Preserve essential commands and conditions; omit background, narration, repetition and filler. " +
        `Maximum ${limits.maxLessonWords} words per lesson and ${limits.maxEvidenceWords} words for evidence (whitespace-separated). ` +
        "These are ceilings, not targets. Overlong saves are rejected, not truncated." };
    } catch {
      // The context hook reports initialization failures without blocking the agent.
      return;
    }
  });

  pi.on("context", (event, ctx) => {
    // Rebuilt from SQLite and cwd's legacy file(s): no stale recall after compaction or external edits.
    const messages = event.messages.filter((message) => message.role !== "custom" || message.customType !== CONTEXT_TYPE);
    return { messages: [{ role: "custom" as const, customType: CONTEXT_TYPE, content: recall(ctx), display: false, timestamp: 0 }, ...messages] };
  });

  pi.registerTool({
    name: "memory",
    label: "Project memory",
    description: "SQLite lessons for this project only. list/search return paged results capped at 16 KiB; use nextOffset for more. " +
      "add/update require text, evidence, and basis (validated_fix or user_request). Evidence describes the verification or explicit memory request. " +
      "update/archive/restore require id and the current revision from get/list. Exact duplicates are not added; archived duplicates stay archived. " +
      "No secrets or raw transcripts. In ephemeral sessions, writes require basis=user_request.",
    promptSnippet: "Read and maintain SQLite project lessons",
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.String({ maxLength: 80 })),
      revision: Type.Optional(Type.Integer({ minimum: 1 })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
      evidence: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE })),
      basis: Type.Optional(StringEnum(["validated_fix", "user_request"] as const)),
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      state: Type.Optional(StringEnum(["active", "archived", "all"] as const)),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { store, scope } = current(ctx);
      if (!["list", "search", "get"].includes(params.action) && !ctx.sessionManager.getSessionFile() && params.basis !== "user_request") {
        throw new Error("Ephemeral sessions require an explicit user memory request for persistent writes");
      }
      const result = runMemory(store, scope, params, origin(ctx));
      // Saving succeeded even if a later status/recall refresh fails; report the commit accurately.
      try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerCommand("memory", {
    description: "Inspect, save, search, edit, archive, import or export project lessons",
    getArgumentCompletions(prefix) {
      return COMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      try {
        const [command, rest] = firstWord(args);
        if (command === "help") { show(HELP, ctx); return; }
        if (command === "reload") reset();
        const { store, path, scope } = current(ctx);
        const source = origin(ctx);
        if (!command || command === "reload") {
          show(`Database: ${JSON.stringify(path)}\n${recall(ctx)}`, ctx);
          return;
        }
        if (command === "import") {
          if (importing) throw new Error("An import is already in progress; cancel it or use /memory reload");
          const files = rest ? [rest] : legacyFiles(ctx.cwd);
          if (files.length !== 1) throw new Error("Usage: /memory import <path> (select exactly one source)");
          const controller = new AbortController();
          importing = controller;
          const started = generation;
          const cwd = ctx.cwd;
          const check = () => {
            controller.signal.throwIfAborted();
            if (generation !== started || state?.store !== store || state.scope !== scope || ctx.cwd !== cwd ||
                ctx.sessionManager.getSessionId() !== source.session || projectScope(cwd) !== scope) {
              throw new Error("Session or project changed; import cancelled");
            }
          };
          try {
            const result = await reviewedImport(ctx, { store, path, scope, cwd, limits: state!.limits,
              file: files[0], origin: source, signal: controller.signal, check });
            if (generation === started) {
              // Imports require UI. Preserve all lesson IDs and hashes, even after a large batch.
              ctx.ui.notify(result ? JSON.stringify(result, null, 2) : "Import cancelled; nothing saved.", "info");
            }
          } finally {
            if (importing === controller) importing = undefined;
          }
        } else if (command === "export") {
          if (!rest) throw new Error("Usage: /memory export <new-path>");
          const output = exportPath(scope, ctx.cwd, rest);
          const count = await withFileMutationQueue(output, async () => {
            if (state?.store !== store || state.scope !== scope) throw new Error("Session changed before export");
            return exportMarkdown(store, scope, output);
          });
          show({ output, lessons: count }, ctx);
        } else {
          let request: MemoryRequest;
          if (command === "list" || command === "archived") {
            request = { action: "list", state: command === "archived" ? "archived" : "active", offset: rest ? Number(rest) : 0 };
          } else if (command === "search") {
            request = { action: "search", query: rest };
          } else if (command === "get") {
            request = { action: "get", id: rest };
          } else if (command === "add") {
            request = { action: "add", text: rest, basis: "user_request", evidence: "User-requested." };
          } else if (command === "edit" || command === "archive" || command === "restore") {
            const [id, text] = firstWord(rest);
            const item = store.get(scope, id);
            request = { action: command === "edit" ? "update" : command, id, revision: item.revision,
              text, basis: "user_request", evidence: "User-requested." };
          } else {
            throw new Error(HELP);
          }
          show(runMemory(store, scope, request, source), ctx);
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

function firstWord(value: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(value.trim());
  return match ? [match[1], match[2]] : ["", ""];
}
