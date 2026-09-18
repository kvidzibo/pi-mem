import { join } from "node:path";
import { getAgentDir, withFileMutationQueue, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { memoryConfig } from "./config.ts";
import { memoryMenu, type MenuState } from "./menu.ts";
import { exportMarkdown, exportPath } from "./markdown.ts";
import { reviewedImport } from "./import-review.ts";
import { legacyContext, legacyFiles } from "./legacy.ts";
import { ACTIONS, runMemory, type MemoryRequest } from "./operations.ts";
import { boundedPage, clipped, memoryContext, RESULT_BYTES } from "./presentation.ts";
import { projectScope } from "./project.ts";
import { MAX_EVIDENCE, MAX_TEXT, MemoryStore, type Origin } from "./store.ts";

const CONTEXT_TYPE = "pi-mem-context";
const COMMANDS = ["list", "search", "get", "add", "supersede", "archive", "archived", "import", "export", "reload", "help"];
const HELP = [
  "/memory — open the project memory menu (text status without UI)",
  "/memory list [offset] | archived [offset] | search <text> | get <id>",
  "/memory add <lesson> | supersede <id> <lesson> | archive <id>",
  "/memory import [path] — draft if needed, review Before/After preview, approve import; source always kept unchanged",
  "/memory export <new-path> — active lesson text, no overwrite",
  "/memory reload — reconnect and reread database configuration",
].join("\n");

export default function memoryExtension(pi: ExtensionAPI) {
  let state: MenuState | undefined;
  let failed: Error | undefined;
  let notified: string | undefined;
  let legacyNotified: string | undefined;
  let importing: AbortController | undefined;
  let menu: AbortController | undefined;
  let generation = 0;

  function reset() {
    generation++;
    menu?.abort(new Error("Session or memory configuration changed; menu closed"));
    // Keep the guard until the old command unwinds, including pending import dialogs.
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

  async function importFile(file: string, ctx: ExtensionContext) {
    if (importing) throw new Error("An import is already in progress; cancel it or use /memory reload");
    const { store, path, scope, limits } = current(ctx);
    const source = origin(ctx);
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
      const result = await reviewedImport(ctx, { store, path, scope, cwd, limits,
        file, origin: source, signal: controller.signal, check });
      if (generation === started) {
        // Imports require UI. Preserve all lesson IDs and hashes, even after a large batch.
        ctx.ui.notify(result ? JSON.stringify(result, null, 2) : "Import cancelled; nothing saved.", "info");
        try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
      }
    } finally {
      if (importing === controller) importing = undefined;
    }
  }

  async function openMenu(ctx: ExtensionContext) {
    if (menu || importing) throw new Error("A memory menu or import is already open; close it first");
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
          importFile: (file) => { check(); return importFile(file, ctx); },
        });
        check();
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      } finally {
        if (menu === controller) menu = undefined;
      }
      if (action !== "reload") return;
      reset();
      try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
    }
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
      return { systemPrompt: event.systemPrompt + "\n\nFor memory add/supersede: save one actionable point, preferably one sentence. " +
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
    description: "Write project lessons. Active lessons are recalled automatically; no on-demand reads. " +
      "add/supersede require text, evidence, and basis: validated_learning for verified discoveries, validated_fix for corrections, " +
      "or user_request for explicit memory requests. Evidence describes the verification or explicit memory request. " +
      "supersede requires an active lesson id; it creates a replacement and archives the original atomically. archive requires id. " +
      "Records are retained: no in-place edits, restore, or delete. Exact active duplicates are not added. " +
      "No secrets or raw transcripts. In ephemeral sessions, writes require basis=user_request.",
    promptSnippet: "Add, supersede, or archive project lessons",
    parameters: Type.Object({
      action: StringEnum(ACTIONS),
      id: Type.Optional(Type.String({ maxLength: 80 })),
      text: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT })),
      evidence: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_EVIDENCE })),
      basis: Type.Optional(StringEnum(["validated_learning", "validated_fix", "user_request"] as const)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const { store, scope } = current(ctx);
      if (!ctx.sessionManager.getSessionFile() && params.basis !== "user_request") {
        throw new Error("Ephemeral sessions require an explicit user memory request for persistent writes");
      }
      const result = runMemory(store, scope, params, origin(ctx));
      // Saving succeeded even if a later status/recall refresh fails; report the commit accurately.
      try { snapshot(ctx); } catch (error) { unavailable(error, ctx); }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  pi.registerCommand("memory", {
    description: "Open the project memory menu, or use lesson subcommands",
    getArgumentCompletions(prefix) {
      return COMMANDS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      try {
        const [command, rest] = firstWord(args);
        if (command === "help") { show(HELP, ctx); return; }
        if (!command && ctx.hasUI) { await openMenu(ctx); return; }
        if (command === "reload") reset();
        const { store, path, scope } = current(ctx);
        const source = origin(ctx);
        if (!command || command === "reload") {
          show(`Database: ${JSON.stringify(path)}\n${recall(ctx)}`, ctx);
          return;
        }
        if (command === "import") {
          if (menu) throw new Error("A memory menu is already open; close it before running an import command");
          const files = rest ? [rest] : legacyFiles(ctx.cwd);
          if (files.length !== 1) throw new Error("Usage: /memory import <path> (select exactly one source)");
          await importFile(files[0], ctx);
        } else if (command === "export") {
          if (!rest) throw new Error("Usage: /memory export <new-path>");
          const output = exportPath(scope, ctx.cwd, rest);
          const count = await withFileMutationQueue(output, async () => {
            if (state?.store !== store || state.scope !== scope) throw new Error("Session changed before export");
            return exportMarkdown(store, scope, output);
          });
          show({ output, lessons: count }, ctx);
        } else if (command === "list" || command === "archived") {
          const offset = rest ? Number(rest) : 0;
          show(boundedPage(store.list(scope, { state: command === "archived" ? "archived" : "active", offset }), offset), ctx);
        } else if (command === "search") {
          if (!rest.trim()) throw new Error("search requires query");
          show(boundedPage(store.list(scope, { query: rest }), 0), ctx);
        } else if (command === "get") {
          show(store.get(scope, rest), ctx);
        } else {
          let request: MemoryRequest;
          if (command === "add") {
            request = { action: "add", text: rest, basis: "user_request", evidence: "User-requested." };
          } else if (command === "supersede" || command === "archive") {
            const [id, text] = firstWord(rest);
            request = { action: command, id, text, basis: "user_request", evidence: "User-requested." };
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
