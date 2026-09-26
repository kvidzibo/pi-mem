import { statSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { MemoryLimits } from "./limits.ts";
import { destinationInput, lessonEditor, menuChoice, words } from "./menu-ui.ts";
import { clipped, memoryContext, visible } from "./presentation.ts";
import { moveDestination, projectScope } from "./project.ts";
import { checkNew, DEFAULT_PRIORITY, type Lesson, type MemoryStore, type Origin } from "./store.ts";

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
  archived: (id: number) => void;
  signal: AbortSignal;
  origin: Origin;
  configPath: string;
  help: string;
}

const item = (value: string, label: string): SelectItem => ({ value, label });
const BACK = item("back", "Back");
const CANCEL = item("cancel", "Cancel");
const PAGE_SIZE = 1000;
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

  async function choosePriority(current: number): Promise<number | undefined> {
    const result = await choose("Lesson priority", "0 = user-reserved extreme · 1 = highest · 10 = lowest",
      [...Array.from({ length: 11 }, (_, priority) => item(String(priority),
        `${priority}${priority === 0 ? " — Extreme (user-only)" : priority === 1 ? " — Highest" : priority === 10 ? " — Lowest" : ""}`)), CANCEL], String(current));
    return result === undefined || result === "cancel" ? undefined : Number(result);
  }

  async function saveLesson(previous?: Lesson): Promise<boolean> {
    let draft = previous?.text ?? "";
    let priority = previous?.priority ?? DEFAULT_PRIORITY;
    let editing = true;
    while (true) {
      const { limits } = access.current();
      const edited = editing ? await lessonEditor(ctx, previous ? "Replace lesson" : "Add lesson", draft, limits.maxLessonWords, signal) : draft;
      editing = true;
      access.check();
      if (edited === undefined) return false;
      draft = edited;
      let input;
      try { input = checkNew({ text: draft, evidence: "User-requested.", basis: "user_request", priority }, limits); }
      catch (error) { reportError(error); continue; }
      const body = [
        ...(previous ? ["BEFORE", previous.text, "", "AFTER"] : []), input.text, "",
        `${words(input.text)}/${limits.maxLessonWords} words · Evidence: ${input.evidence} · Priority: ${priority}`,
        previous ? "Saving creates a replacement and archives the original. Both records are retained." : "Save this lesson to the current project's memory?",
      ].join("\n");
      const action = await choose(previous ? "Review replacement" : "Review new lesson", body,
        [CANCEL, item("edit", "Edit…"), item("priority", "Priority…"), item("save", "Save")]);
      if (!action || action === "cancel") return false;
      if (action === "edit") continue;
      if (action === "priority") {
        priority = await choosePriority(priority) ?? priority;
        editing = false;
        continue;
      }
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
      const { store, scope, limits } = access.current();
      const lesson = store.get(scope, history.at(-1)!);
      const loaded = memoryContext(store.recall(scope), limits.maxRecallBytes).loadedIds.includes(lesson.id);
      const body = [
        lesson.text, "", `Priority: ${lesson.priority}${lesson.priority === 0 ? " (user-reserved extreme)" : ""}`, `Evidence: ${lesson.evidence}`, "",
        `State: ${lesson.archived ? "archived (not recalled)" : loaded ? "active · loaded into recall" : "active · omitted by recall limits"}`,
        `Created: ${new Date(lesson.created_at).toISOString()}`, `Basis: ${lesson.basis}`,
        `Origin: ${lesson.source_harness} · session ${lesson.source_session ?? "(none)"}`,
        `ID: #${lesson.id}`, `Predecessor: ${lesson.supersedes_id === null ? "(none)" : `#${lesson.supersedes_id}`}`,
        ...(lesson.archived ? [`Archived: ${lesson.archived_at === null ? "date unknown" : new Date(lesson.archived_at).toISOString()}`,
          "Archived records are read-only except for project moves. No restore or delete."] : []),
      ].join("\n");
      const action = await choose("Lesson details", body, [BACK, item("move", "Move lesson…"),
        ...(!lesson.archived ? [item("replace", "Replace…"), item("priority", "Change priority…"), item("archive", "Archive…")] : []),
        ...(lesson.supersedes_id ? [item("predecessor", "View predecessor")] : []),
      ]);
      if (!action || action === "back") { history.pop(); continue; }
      if (action === "predecessor") { history.push(lesson.supersedes_id!); continue; }
      if (action === "move") { if (await moveLesson(lesson)) return; }
      if (action === "replace") { if (await saveLesson(lesson)) return; }
      if (action === "priority") {
        const priority = await choosePriority(lesson.priority);
        if (priority !== undefined) {
          const current = access.current();
          current.store.setPriority(current.scope, lesson.id, priority, access.origin);
          access.refresh();
          ctx.ui.notify(`Lesson #${lesson.id} priority: ${priority}. Content unchanged.`, "info");
        }
      }
      if (action === "archive") {
        const confirmed = await choose("Archive lesson?", `${lesson.text}\n\nExclude this lesson from future recall; retain the record.\nThis cannot erase text already in a conversation. There is no restore operation.`,
          [CANCEL, item("archive", "Archive")]);
        if (confirmed !== "archive") continue;
        const current = access.current();
        const result = current.store.archive(current.scope, lesson.id);
        if (result.changed) access.archived(result.lesson.id);
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
      const { store, scope, limits } = access.current();
      let nextOffset: number | null = null;
      const listing = () => {
        let page = store.list(scope, { state: archived ? "archived" : "active", offset, limit: PAGE_SIZE, query: query || undefined });
        if (!page.lessons.length && offset > 0) {
          offset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          page = store.list(scope, { state: archived ? "archived" : "active", offset, limit: PAGE_SIZE, query: query || undefined });
        }
        nextOffset = page.nextOffset;
        const loaded = new Set(memoryContext(store.recall(scope), limits.maxRecallBytes).loadedIds);
        const rows = page.lessons.map((lesson, index) => item(String(lesson.id),
          `${offset + index + 1}. [P${lesson.priority}] ${archived ? "[archived] " : loaded.has(lesson.id) ? "" : "[omitted] "}${clipped(lesson.text.replace(/\s+/gu, " "), 240)}`));
        const body = [
          query ? `Search: ${query}` : "All lessons · priority first, then newest",
          page.total ? `${offset + 1}–${offset + page.lessons.length} of ${page.total}` : "No lessons found.",
          archived ? "Read-only retained records." : "[omitted] marks lessons excluded by current recall limits; refreshed for each model request.",
        ].join("\n");
        return { body, items: [
          ...rows, ...(ctx.mode !== "tui" ? [item("search", "Search…"), ...(query ? [item("clear", "Clear search")] : [])] : []),
          ...(offset ? [item("previous", "Previous page")] : []), ...(page.nextOffset !== null ? [item("next", "Next page")] : []), BACK,
        ] };
      };
      const initial = listing();
      access.check();
      const action = await menuChoice(ctx, archived ? "Archived lessons" : "Browse / search lessons", initial.body, initial.items,
        signal, selected, { query, update: (text) => {
          access.check();
          query = text.trim();
          offset = 0;
          selected = undefined;
          return listing();
        } });
      access.check();
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
      else if (action === "next") { offset = nextOffset!; selected = undefined; }
      else if (action === "previous") { offset = Math.max(0, offset - PAGE_SIZE); selected = undefined; }
      else {
        selected = action;
        try { await details(Number(action)); }
        catch (error) { access.check(); reportError(error); }
      }
    }
  }

  async function moveLesson(lesson: Lesson): Promise<boolean> {
    const entered = await destinationInput(ctx, ctx.cwd, signal);
    access.check();
    if (entered === undefined) return false;
    const { path, scope: to } = moveDestination(ctx.cwd, entered);
    if (lesson.scope === to) throw new Error("Source and destination are the same project");
    const confirmed = await choose("Move lesson?", `#${lesson.id}: ${lesson.text}\n\nFrom: ${lesson.scope}\nTo: ${to}\n\nMove this lesson and its entire linked replacement history, including any successor. IDs and metadata stay unchanged.\nUnrelated lessons stay put. Duplicate active text is refused. No files move.`,
      [CANCEL, item("move", "Move lesson")]);
    if (confirmed !== "move") return false;
    if (!statSync(path).isDirectory() || projectScope(path) !== to) throw new Error("Destination changed; nothing moved");
    const current = access.current();
    const moved = current.store.moveLesson(current.scope, lesson.id, to);
    access.refresh();
    ctx.ui.notify(`Moved lesson #${lesson.id} and linked history (${moved} records) to ${JSON.stringify(to)}.`, "info");
    return true;
  }

  async function moveMemory() {
    const scopes = access.current().store.listScopes();
    const source = await choose("Move memory — select stored cwd", "Includes active and archived lessons. No folders or files are moved.",
      [...scopes.map((scope, index) => item(String(index), `${index + 1}. ${scope}`)), BACK]);
    if (source === undefined || source === "back") return;
    const from = scopes[Number(source)];
    if (!from) return;
    const entered = await destinationInput(ctx, ctx.cwd, signal);
    access.check();
    if (entered === undefined) return;
    const { path, scope: to } = moveDestination(ctx.cwd, entered);
    const { store } = access.current();
    if (from === to) throw new Error("Source and destination are the same project");
    if (store.list(to, { state: "all", limit: 1 }).total) throw new Error("Destination already has memories; nothing moved");
    const count = store.list(from, { state: "all", limit: 1 }).total;
    const confirmed = await choose("Move memory?", `From: ${from}\nTo: ${to}\n\nMove all ${count} lessons, including archived history. IDs and predecessor links stay unchanged.\nThe destination uses its canonical Git root, or cwd outside Git. No merge or file move.`,
      [CANCEL, item("move", "Move memory")]);
    if (confirmed !== "move") return;
    if (!statSync(path).isDirectory() || projectScope(path) !== to) throw new Error("Destination changed; nothing moved");
    const moved = access.current().store.moveScope(from, to);
    access.refresh();
    ctx.ui.notify(`Moved ${moved} lessons to ${JSON.stringify(to)}.`, "info");
  }

  async function status() {
    const lines = [`Config: ${JSON.stringify(access.configPath)}`, `Pi cwd: ${JSON.stringify(ctx.cwd)}`];
    try {
      const { store, path, scope, limits } = access.current();
      const page = store.recall(scope);
      const recalled = memoryContext(page, limits.maxRecallBytes);
      lines.push(`Project scope: ${JSON.stringify(scope)}`, `Database: ${JSON.stringify(path)}`,
        `Active: ${page.total} · Loaded: ${recalled.loaded} · Omitted: ${page.total - recalled.loaded}`,
        `Archived: ${store.list(scope, { state: "archived", limit: 1 }).total}`,
        `Lesson limit: ${limits.maxLessonWords} words · Evidence limit: ${limits.maxEvidenceWords} words`,
        `Recall limit: ${limits.maxRecallLessons} lessons or ${limits.maxRecallBytes / 1024} KiB, whichever fills first.`,
        "Recall uses lowest-numbered priority first, then newest-created. Omitted lessons remain stored.",
        "Limits are read-only here. Changing the database path selects another store; it does not move data.");
    } catch (error) { lines.push(`Memory unavailable: ${errorText(error)}`, "Reload memory retries initialization."); }
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
      const recalled = memoryContext(page, state.limits.maxRecallBytes);
      summary = `${page.total} active · ${recalled.loaded} loaded into context`;
      if (!page.total) summary += "\nNo lessons yet. Add a lesson.";
    } catch (error) { state = undefined; summary = `Memory unavailable: ${errorText(error)}`; }
    const action = await choose(`Memory · ${basename(state?.scope ?? ctx.cwd)}`, summary, [
      ...(state ? [item("browse", "Browse / search lessons"), item("add", "Add lesson"), item("archived", "Archived lessons"),
        item("move", "Move memory")] : []),
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
      else if (action === "move") await moveMemory();
    } catch (error) { access.check(); reportError(error); }
  }
}
