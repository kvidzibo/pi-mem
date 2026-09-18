import { basename } from "node:path";
import { withFileMutationQueue, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { legacyContext, legacyFiles } from "./legacy.ts";
import type { MemoryLimits } from "./limits.ts";
import { exportMarkdown, exportPath } from "./markdown.ts";
import { lessonEditor, menuChoice, words } from "./menu-ui.ts";
import { CONTEXT_BYTES, clipped, memoryContext, visible } from "./presentation.ts";
import { projectScope } from "./project.ts";
import { checkNew, type Lesson, type MemoryStore, type Origin } from "./store.ts";

export interface MenuState {
  store: MemoryStore;
  path: string;
  scope: string;
  cwd: string;
  limits: Readonly<MemoryLimits>;
}

interface MenuAccess {
  current: () => MenuState;
  check: () => void;
  refresh: () => void;
  saved: (ids: number[]) => void;
  importFile: (file: string) => Promise<void>;
  signal: AbortSignal;
  origin: Origin;
  configPath: string;
  help: string;
}

const item = (value: string, label: string): SelectItem => ({ value, label });
const BACK = item("back", "Back");
const CANCEL = item("cancel", "Cancel");
const PAGE_SIZE = 10;
const errorText = (error: unknown) => visible(clipped(error instanceof Error ? error.message : String(error), 1000));

/** Human-only navigation: no session messages or direct model calls. */
export async function memoryMenu(ctx: ExtensionContext, access: MenuAccess): Promise<"reload" | undefined> {
  const { signal } = access;
  const choose = async (title: string, body: string, items: SelectItem[], selected?: string) => {
    access.check();
    const result = await menuChoice(ctx, title, body, items, signal, selected);
    access.check();
    return result;
  };
  const reportError = (error: unknown) => ctx.ui.notify(errorText(error), "error");

  async function saveLesson(previous?: Lesson): Promise<boolean> {
    let draft = previous?.text ?? "";
    while (true) {
      const { limits } = access.current();
      const edited = await lessonEditor(ctx, previous ? "Replace lesson" : "Add lesson", draft, limits.maxLessonWords, signal);
      access.check();
      if (edited === undefined) return false;
      draft = edited;
      let input;
      try { input = checkNew({ text: draft, evidence: "User-requested.", basis: "user_request" }, limits); }
      catch (error) { reportError(error); continue; }
      const body = [
        ...(previous ? ["BEFORE", previous.text, "", "AFTER"] : []), input.text, "",
        `${words(input.text)}/${limits.maxLessonWords} words · Evidence: ${input.evidence}`,
        previous ? "Saving creates a replacement and archives the original. Both records are retained." : "Save this lesson to the current project's memory?",
      ].join("\n");
      const action = await choose(previous ? "Review replacement" : "Review new lesson", body,
        [CANCEL, item("edit", "Edit…"), item("save", "Save")]);
      if (!action || action === "cancel") return false;
      if (action === "edit") continue;
      const { store, scope } = access.current();
      if (previous) {
        const replacement = store.supersede(scope, previous.id, input, access.origin);
        access.saved([replacement.id]);
        ctx.ui.notify(`Lesson replaced: ${replacement.id}. Original retained.`, "info");
      } else {
        const result = store.add(scope, input, access.origin);
        if (result.created) access.saved([result.lesson.id]);
        ctx.ui.notify(result.created ? `Lesson saved: ${result.lesson.id}` : `Already active: ${result.lesson.id}`, "info");
      }
      access.refresh();
      return true;
    }
  }

  async function details(initialId: number) {
    const history = [initialId];
    while (history.length) {
      const { store, scope } = access.current();
      const lesson = store.get(scope, history.at(-1)!);
      const loaded = memoryContext(store.recall(scope)).loadedIds.includes(lesson.id);
      const body = [
        lesson.text, "", `Evidence: ${lesson.evidence}`, "",
        `State: ${lesson.archived ? "archived (not recalled)" : loaded ? "active · loaded into recall" : "active · omitted by recall limits"}`,
        `Created: ${new Date(lesson.created_at).toISOString()}`, `Basis: ${lesson.basis}`,
        `Origin: ${lesson.source_harness} · session ${lesson.source_session ?? "(none)"}`,
        `ID: #${lesson.id}`, `Predecessor: ${lesson.supersedes_id === null ? "(none)" : `#${lesson.supersedes_id}`}`,
        ...(lesson.archived ? [`Archived: ${lesson.archived_at === null ? "date unknown" : new Date(lesson.archived_at).toISOString()}`,
          "Archived records are read-only. No restore or delete."] : []),
      ].join("\n");
      const action = await choose("Lesson details", body, [BACK,
        ...(!lesson.archived ? [item("replace", "Replace…"), item("archive", "Archive…")] : []),
        ...(lesson.supersedes_id ? [item("predecessor", "View predecessor")] : []),
      ]);
      if (!action || action === "back") { history.pop(); continue; }
      if (action === "predecessor") { history.push(lesson.supersedes_id!); continue; }
      if (action === "replace") { if (await saveLesson(lesson)) return; }
      if (action === "archive") {
        const confirmed = await choose("Archive lesson?", `${lesson.text}\n\nExclude this lesson from future recall; retain the record.\nThis cannot erase text already in a conversation. There is no restore operation.`,
          [CANCEL, item("archive", "Archive")]);
        if (confirmed !== "archive") continue;
        const current = access.current();
        current.store.archive(current.scope, lesson.id);
        ctx.ui.notify("Lesson archived; excluded from future recall. Record retained.", "info");
        access.refresh();
        return;
      }
    }
  }

  async function browse(archived: boolean) {
    let offset = 0;
    let query = "";
    let selected: string | undefined;
    while (true) {
      const { store, scope } = access.current();
      let page = store.list(scope, { state: archived ? "archived" : "active", offset, limit: PAGE_SIZE, query: query || undefined });
      if (!page.lessons.length && offset > 0) {
        offset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE);
        page = store.list(scope, { state: archived ? "archived" : "active", offset, limit: PAGE_SIZE, query: query || undefined });
      }
      const loaded = new Set(memoryContext(store.recall(scope)).loadedIds);
      const rows = page.lessons.map((lesson, index) => item(String(lesson.id),
        `${offset + index + 1}. [${archived ? "archived" : loaded.has(lesson.id) ? "loaded" : "omitted"}] ${clipped(lesson.text.replace(/\s+/gu, " "), 240)}`));
      const body = [
        query ? `Search: ${query}` : "All lessons · newest first",
        page.total ? `${offset + 1}–${offset + page.lessons.length} of ${page.total}` : "No lessons found.",
        archived ? "Read-only retained records." : "Loaded/omitted reflects current recall limits; refreshed for each model request.",
      ].join("\n");
      const action = await choose(archived ? "Archived lessons" : "Browse / search lessons", body, [
        ...rows, item("search", "Search…"), ...(query ? [item("clear", "Clear search")] : []),
        ...(offset ? [item("previous", "Previous page")] : []), ...(page.nextOffset !== null ? [item("next", "Next page")] : []), BACK,
      ], selected);
      if (!action || action === "back") return;
      if (action === "search") {
        const text = await ctx.ui.input("Search lesson text / evidence (literal substring, max 200 characters; blank clears)", query, { signal });
        access.check();
        if (text === undefined) continue;
        const nextQuery = text.trim();
        try { store.list(scope, { state: archived ? "archived" : "active", query: nextQuery || undefined, limit: 1 }); }
        catch (error) { reportError(error); continue; }
        query = nextQuery; offset = 0; selected = undefined;
      } else if (action === "clear") { query = ""; offset = 0; selected = undefined; }
      else if (action === "next") { offset = page.nextOffset!; selected = undefined; }
      else if (action === "previous") { offset = Math.max(0, offset - PAGE_SIZE); selected = undefined; }
      else {
        selected = action;
        try { await details(Number(action)); }
        catch (error) { access.check(); reportError(error); }
      }
    }
  }

  async function status() {
    const lines = [`Config: ${JSON.stringify(access.configPath)}`, `Pi cwd: ${JSON.stringify(ctx.cwd)}`];
    try {
      const { store, path, scope, limits } = access.current();
      const page = store.recall(scope);
      const recalled = memoryContext(page);
      lines.push(`Project scope: ${JSON.stringify(scope)}`, `Database: ${JSON.stringify(path)}`,
        `Active: ${page.total} · Loaded: ${recalled.loaded} · Omitted: ${page.total - recalled.loaded}`,
        `Archived: ${store.list(scope, { state: "archived", limit: 1 }).total}`,
        `Lesson limit: ${limits.maxLessonWords} words · Evidence limit: ${limits.maxEvidenceWords} words`,
        `Recall limit: ${limits.maxRecallLessons} lessons or ${CONTEXT_BYTES / 1024} KiB, whichever fills first.`,
        "Recall uses newest-created lessons first. Omitted lessons remain stored.",
        "Limits are read-only here. Changing the database path selects another store; it does not move data.");
    } catch (error) { lines.push(`Memory unavailable: ${errorText(error)}`, "Reload memory retries initialization."); }
    try {
      // Legacy inspection is independent of a working database/configuration.
      lines.push("", legacyContext(projectScope(ctx.cwd), ctx.cwd).warning || "No legacy MEMORY.md found in Pi's cwd.");
    } catch (error) { lines.push(`Legacy warning: ${errorText(error)}`); }
    await choose("Status & limits", lines.join("\n"), [BACK]);
  }

  let selected: string | undefined;
  while (true) {
    access.check();
    let state: MenuState | undefined;
    let summary: string;
    try {
      state = access.current();
      const page = state.store.recall(state.scope);
      const recalled = memoryContext(page);
      summary = `${page.total} active · ${recalled.loaded} loaded into context`;
      if (!page.total) summary += "\nNo lessons yet. Add a lesson or import Markdown.";
    } catch (error) { state = undefined; summary = `Memory unavailable: ${errorText(error)}`; }
    const action = await choose(`Memory · ${basename(state?.scope ?? ctx.cwd)}`, summary, [
      ...(state ? [item("browse", "Browse / search lessons"), item("add", "Add lesson"), item("archived", "Archived lessons"),
        item("import", "Import Markdown…"), item("export", "Export Markdown…")] : []),
      item("status", "Status & limits"), item("reload", "Reload memory"), item("help", "Help"),
    ], selected);
    if (!action) return;
    selected = action;
    if (action === "reload") return "reload";
    try {
      if (action === "status") await status();
      else if (action === "help") await choose("Memory help", access.help + "\n\nBrowsing stays in the UI; it does not add conversation messages.\nReplace and archive retain records. There is no restore or delete.", [BACK]);
      else if (action === "browse" || action === "archived") await browse(action === "archived");
      else if (action === "add") await saveLesson();
      else if (action === "import") {
        let source: string | undefined;
        try { const files = legacyFiles(ctx.cwd); if (files.length === 1) source = files[0]; }
        catch (error) { ctx.ui.notify(errorText(error), "warning"); }
        const file = await ctx.ui.input("Import Markdown — project-relative path; blank uses detected MEMORY.md", source, { signal });
        access.current();
        if (file !== undefined) {
          const path = file || source;
          if (!path) throw new Error("Enter a Markdown source path");
          await access.importFile(path);
        }
      } else if (action === "export") {
        const file = await ctx.ui.input("Export active text (not a database backup) — new project-relative path, no overwrite", "memory-export.md", { signal });
        if (file === undefined) continue;
        const { store, scope, cwd } = access.current();
        if (!file) throw new Error("Enter an export path");
        const output = exportPath(scope, cwd, file);
        const count = await withFileMutationQueue(output, async () => {
          access.current();
          return exportMarkdown(store, scope, output);
        });
        ctx.ui.notify(`Exported ${count} active lessons to ${JSON.stringify(output)}. This is not a database backup.`, "info");
      }
    } catch (error) { access.check(); reportError(error); }
  }
}
