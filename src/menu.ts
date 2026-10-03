import { statSync } from "node:fs";
import { basename } from "node:path";
import { homedir } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { MemoryLimits } from "./limits.ts";
import { destinationInput, lessonEditor, menuChoice, words } from "./menu-ui.ts";
import { buildAudit, stagedAudit, writeAudit } from "./audit.ts";
import { Backups, BACKUP_FREQUENCIES, backupFolder, backupReport, backupStatsText, type BackupFrequency } from "./backups.ts";
import { clipped, formatTokens, globalRecallBytes, memoryContext, visible } from "./presentation.ts";
import { moveDestination, projectScope } from "./project.ts";
import { checkNew, DEFAULT_PRIORITY, GLOBAL_SCOPE, type Activity, type Lesson, type MemoryStore, type Origin } from "./store.ts";

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

/** Browsing stays private; only an explicitly confirmed audit can request an agent turn. */
export async function memoryMenu(ctx: ExtensionContext, access: MenuAccess): Promise<"reload" | "evaluate" | { audit: { allProjects: boolean } } | undefined> {
  const { signal } = access;
  let browsingScope: string | undefined;
  const viewState = (): MenuState => {
    const state = access.current();
    return browsingScope === undefined ? state : { ...state, scope: browsingScope };
  };
  const isRecalledHere = () => viewState().scope === access.current().scope || viewState().scope === GLOBAL_SCOPE;
  const recallBytes = (state: MenuState) => state.scope === GLOBAL_SCOPE ? globalRecallBytes(state.limits.maxRecallBytes) : state.limits.maxRecallBytes;
  const scopeLabel = (scope: string) => scope === GLOBAL_SCOPE ? "Global" : `Project: ${scope}`;
  const lessonsFor = (state: MenuState) => memoryContext(state.store.recall(state.scope), recallBytes(state), state.scope === GLOBAL_SCOPE ? "GLOBAL LESSONS" : undefined);
  const choose = async (title: string, body: string, items: SelectItem[], selected?: string) => {
    access.check();
    const result = await menuChoice(ctx, title, body, items, signal, selected);
    access.check();
    return result;
  };
  const reportError = (error: unknown) => ctx.ui.notify(errorText(error), "error");

  const omissionReason = (state: MenuState, loaded: number) => loaded < Math.min(state.store.recall(state.scope).total, state.limits.maxRecallLessons)
    ? `byte budget reached (${recallBytes(state)} bytes); recall stops at the first lesson that does not fit`
    : `lesson-count limit reached (${state.limits.maxRecallLessons} ${state.limits.maxRecallLessons === 1 ? "lesson" : "lessons"})`;

  async function choosePriority(current: number): Promise<number | undefined> {
    const result = await choose("Lesson priority", `${scopeLabel(viewState().scope)}\nCurrent priority: ${current}\n0 = user-reserved extreme · 1 = highest · 10 = lowest`,
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
      const edited = editing ? await lessonEditor(ctx, previous ? "Replace lesson" : "Add lesson", draft, limits.maxLessonWords, signal, scopeLabel(viewState().scope)) : draft;
      editing = true;
      access.check();
      if (edited === undefined) return false;
      draft = edited;
      let input;
      try { input = checkNew({ text: draft, evidence: "User-requested.", basis: "user_request", priority }, limits); }
      catch (error) { reportError(error); continue; }
      const body = [
        scopeLabel(viewState().scope), "",
        ...(previous ? ["BEFORE", previous.text, "", "AFTER"] : []), input.text, "",
        `${words(input.text)}/${limits.maxLessonWords} words · Evidence: ${input.evidence} · Priority: ${priority}`,
        previous ? "Saving creates a replacement and archives the original. Both records are retained." :
          viewState().scope === GLOBAL_SCOPE ? "Save this global lesson for recall in every project?" : "Save this lesson to the project shown above?",
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
      const { store, scope } = viewState();
      if (previous) {
        const replacement = store.supersede(scope, previous.id, input, access.origin);
        if (isRecalledHere()) access.saved([replacement.id]);
        ctx.ui.notify(`Lesson replaced: ${replacement.id}. Original retained.`, "info");
      } else {
        const result = store.add(scope, input, access.origin);
        if (result.created && isRecalledHere()) access.saved([result.lesson.id]);
        ctx.ui.notify(result.created ? `Lesson saved: ${result.lesson.id}` : `Already active: ${result.lesson.id}`, "info");
      }
      access.refresh();
      return true;
    }
  }

  function activitySummary(event: Activity): string {
    const d = event.details;
    switch (event.action) {
      case "set_priority": return `Priority changed: ${d.before} → ${d.after}`;
      case "move": return `Moved: ${scopeLabel(String(d.before))} → ${scopeLabel(String(d.after))}`;
      case "supersede": return `Replaced by #${d.successor_id}; original archived`;
      case "archive": return "Lesson archived; excluded from future recall";
      case "create": case "import": return [event.action === "import" ? "Lesson imported" : "Lesson created",
        ...(d.predecessor_id ? [`replaces #${d.predecessor_id}`] : []),
        ...(typeof d.priority === "number" ? [`priority ${d.priority}`] : []),
        ...(typeof d.scope === "string" ? [scopeLabel(d.scope)] : [])].join(" · ");
      default: return event.action;
    }
  }

  async function activity(id: number) {
    let offset = 0;
    while (true) {
      const { store, scope } = viewState();
      const page = store.history(scope, id, offset, 20);
      const action = await choose(`History · #${id}`, "Retained changes only; browsing and recall are not logged.\nHistorical entries may have unknown attribution or dates.", [
        ...page.events.map((event) => item(String(event.id),
          `${event.at === null ? "Unknown date" : new Date(event.at).toISOString()} · ${activitySummary(event)} · event #${event.id}`)),
        ...(offset ? [item("previous", "Previous page")] : []),
        ...(page.nextOffset !== null ? [item("next", "Next page")] : []), BACK,
      ]);
      if (!action || action === "back") return;
      if (action === "previous") { offset = Math.max(0, offset - 20); continue; }
      if (action === "next") { offset = page.nextOffset!; continue; }
      const event = page.events.find((event) => event.id === Number(action));
      if (!event) continue;
      const related = event.details.successor_id ?? event.details.predecessor_id;
      const linkedId = typeof related === "number" && Number.isSafeInteger(related) && related > 0 ? related : undefined;
      const next = await choose(`Activity · #${id} · ${event.action}`, [
        activitySummary(event), ...(event.reason ? [`Reason: ${event.reason}`] : []), "",
        `Time: ${event.at === null ? "unknown" : new Date(event.at).toISOString()}`,
        `Actor: ${event.actor}`, `Provider: ${event.provider ?? "unknown"}`, `Model: ${event.model ?? "unknown"}`,
        `Harness: ${event.harness}`, `Session: ${event.session ?? "unknown"}`,
        ...(event.historical ? ["Recovered from existing records; missing history cannot be reconstructed."] : []),
        ...(event.details.retained_revision !== undefined ? [`Retained revision: ${event.details.retained_revision}`] : []),
      ].join("\n"), [BACK, ...(linkedId ? [item("linked", `View linked lesson #${linkedId}`)] : [])]);
      if (next === "linked" && linkedId) await details(linkedId);
    }
  }

  async function details(initialId: number) {
    const history = [initialId];
    while (history.length) {
      const { store, scope } = viewState();
      const lesson = store.get(scope, history.at(-1)!);
      const recalled = lessonsFor(viewState());
      const loaded = recalled.loadedIds.includes(lesson.id);
      const body = [
        lesson.text, "", `${scopeLabel(scope)}`, `Priority: ${lesson.priority}${lesson.priority === 0 ? " (user-reserved extreme)" : ""}`, `Evidence: ${lesson.evidence}`, "",
        `State: ${lesson.archived ? "archived (not recalled)" : !isRecalledHere() ? "active · other project (not recalled here)" : loaded ? "active · loaded into recall" : `active · omitted by recall limits: ${omissionReason(viewState(), recalled.loaded)}`}`,
        `Created: ${new Date(lesson.created_at).toISOString()}`, `Basis: ${lesson.basis}`,
        `Origin: ${lesson.source_harness} · session ${lesson.source_session ?? "(none)"}`,
        `ID: #${lesson.id}`, `Predecessor: ${lesson.supersedes_id === null ? "(none)" : `#${lesson.supersedes_id}`}`,
        ...(lesson.archived ? [`Archived: ${lesson.archived_at === null ? "date unknown" : new Date(lesson.archived_at).toISOString()}`,
          "Archived records are read-only except for scope moves. No restore or delete."] : []),
      ].join("\n");
      const action = await choose("Lesson details", body, [
        ...(!lesson.archived ? [item("priority", "Change priority…"), item("replace", "Replace…")] : []),
        item("history", "History"), item("move", "Move lesson to project…"),
        ...(scope === GLOBAL_SCOPE ? [] : [item("global", "Move lesson to global…")]),
        ...(lesson.supersedes_id ? [item("predecessor", "View predecessor")] : []),
        ...(!lesson.archived ? [item("archive", "Archive")] : []), BACK,
      ]);
      if (!action || action === "back") { history.pop(); continue; }
      if (action === "predecessor") { history.push(lesson.supersedes_id!); continue; }
      if (action === "history") { await activity(lesson.id); continue; }
      if (action === "move" || action === "global") { if (await moveLesson(lesson, action === "global")) return; }
      if (action === "replace") { if (await saveLesson(lesson)) return; }
      if (action === "priority") {
        const priority = await choosePriority(lesson.priority);
        if (priority === undefined) continue;
        const current = viewState();
        current.store.setPriority(current.scope, lesson.id, priority, access.origin);
        access.refresh();
        ctx.ui.notify(`Lesson #${lesson.id} priority: ${priority}. Content unchanged.`, "info");
      }
      if (action === "archive") {
        const confirmed = await choose("Archive lesson?", `${scopeLabel(scope)}\n#${lesson.id}: ${lesson.text}\n\nExclude this lesson from future recall; retain the record.\nThis cannot erase text already in a conversation. There is no restore operation.`,
          [CANCEL, item("archive", "Archive")]);
        if (confirmed !== "archive") continue;
        const current = viewState();
        const result = current.store.archive(current.scope, lesson.id, access.origin);
        if (result.changed && isRecalledHere()) access.archived(result.lesson.id);
        ctx.ui.notify("Lesson archived; excluded from future recall. Record retained.", "info");
        access.refresh();
        return;
      }
    }
  }

  async function browse(archived: boolean) {
    let offset = 0;
    let query = "";
    let notRecalled = false;
    let selected: string | undefined;
    while (true) {
      const { store, scope } = viewState();
      let nextOffset: number | null = null;
      const listing = () => {
        const recalled = lessonsFor(viewState());
        const loaded = new Set(recalled.loadedIds);
        const options = { state: archived ? "archived" as const : "active" as const, limit: PAGE_SIZE, query: query || undefined,
          excludeIds: notRecalled && isRecalledHere() ? recalled.loadedIds : undefined };
        let page = store.list(scope, { ...options, offset });
        if (!page.lessons.length && offset > 0) {
          offset = Math.max(0, Math.floor((page.total - 1) / PAGE_SIZE) * PAGE_SIZE);
          page = store.list(scope, { ...options, offset });
        }
        nextOffset = page.nextOffset;
        const rows = page.lessons.map((lesson) => item(String(lesson.id),
          `#${lesson.id} · [P${lesson.priority}] ${archived ? "[archived] " : !isRecalledHere() || loaded.has(lesson.id) ? "" : "[omitted] "}${clipped(lesson.text.replace(/\s+/gu, " "), 240)}`));
        const body = [
          `${scopeLabel(scope)}`, query ? `Search: ${query}` : "All lessons · priority first, then newest",
          ...(notRecalled ? ["Filter: Not recalled"] : []),
          page.total ? `${offset + 1}–${offset + page.lessons.length} of ${page.total}` : "No lessons found.",
          archived ? "Read-only retained records." : !isRecalledHere() ? "Other project: these lessons are not recalled in this session."
            : store.recall(scope).total > recalled.loaded ? `[omitted] ${omissionReason(viewState(), recalled.loaded)}. Change priority or review Status & limits.`
              : "All active lessons fit current recall limits.",
        ].join("\n");
        return { body, selected: rows[0]?.value, items: [
          ...(!archived ? [item("filter", notRecalled ? "Show all active lessons" : "Not recalled only")] : []),
          ...rows, ...(ctx.mode !== "tui" ? [item("search", "Search…"), ...(query ? [item("clear", "Clear search")] : [])] : []),
          ...(offset ? [item("previous", "Previous page")] : []), ...(page.nextOffset !== null ? [item("next", "Next page")] : []), BACK,
        ] };
      };
      const initial = listing();
      access.check();
      const action = await menuChoice(ctx, archived ? "Archived lessons" : "Browse / search lessons", initial.body, initial.items,
        signal, selected ?? initial.selected, { query, update: (text) => {
          access.check();
          query = text.trim();
          offset = 0;
          selected = undefined;
          return listing();
        } });
      access.check();
      if (!action || action === "back") return;
      if (action === "filter") { notRecalled = !notRecalled; offset = 0; selected = "filter"; }
      else if (action === "search") {
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

  async function projectPicker(title: string, scopes: string[], allowPath = false): Promise<string | undefined> {
    let query = "";
    let selected: string | undefined;
    const { store } = access.current();
    // Counts are computed once per picker, not on every keystroke.
    const projects = scopes.map((scope) => {
      const active = store.list(scope, { limit: 1 }).total;
      const archived = store.list(scope, { state: "archived", limit: 1 }).total;
      const path = scope.startsWith(homedir() + "/") ? "~" + scope.slice(homedir().length) : scope;
      return { scope, path, label: `${basename(scope) || scope} · ${active} active / ${archived} archived · ${path}` };
    });
    const listing = () => {
      const matches = projects.filter(({ scope, path }) => scope.toLowerCase().includes(query.toLowerCase()) || path.toLowerCase().includes(query.toLowerCase()));
      return { body: [allowPath ? "Choose a known project or enter an existing directory. No files move." : "Includes archived-only projects and missing folders. Recall stays project-specific.",
        query ? `Search: ${query}` : "All projects", matches.length ? `${matches.length} ${matches.length === 1 ? "project" : "projects"}` : "No projects found."].join("\n"),
      selected: matches[0]?.scope ?? "back",
      items: [...matches.map(({ scope, label }) => item(scope, label)),
        ...(allowPath ? [item("path", "Enter path…")] : []),
        ...(ctx.mode !== "tui" ? [item("search", "Search…"), ...(query ? [item("clear", "Clear search")] : [])] : []), BACK] };
    };
    while (true) {
      access.check();
      const page = listing();
      const action = await menuChoice(ctx, title, page.body, page.items, signal, selected ?? page.selected, {
        query, hint: "Type to search project paths (max 200 characters)",
        update: (text) => { access.check(); query = text.trim(); return listing(); },
      });
      access.check();
      if (!action || action === "back") return;
      selected = action;
      if (action === "search") {
        const text = await ctx.ui.input("Search project paths (max 200 characters; blank clears)", query, { signal });
        access.check();
        if (text !== undefined) query = text.trim().slice(0, 200);
      } else if (action === "clear") query = "";
      else if (action === "path") {
        const entered = await destinationInput(ctx, ctx.cwd, signal);
        access.check();
        if (entered !== undefined) return entered;
      } else return action;
    }
  }

  async function projectDestination(from: string, wholeProject = false): Promise<string | undefined> {
    const { store, scope } = access.current();
    const scopes = [...new Set([scope, ...store.listScopes()])].filter((candidate) => {
      if (candidate === GLOBAL_SCOPE || candidate === from) return false;
      try { if (!statSync(candidate).isDirectory()) return false; }
      catch { return false; } // Missing stored folders remain browsable, but cannot receive a move.
      return !wholeProject || store.list(candidate, { state: "all", limit: 1 }).total === 0;
    });
    return projectPicker("Move to project", scopes, true);
  }

  async function moveLesson(lesson: Lesson, global: boolean): Promise<boolean> {
    let destination: ReturnType<typeof moveDestination> | undefined;
    if (!global) {
      const entered = await projectDestination(lesson.scope);
      access.check();
      if (entered === undefined) return false;
      destination = moveDestination(ctx.cwd, entered);
    }
    const to = destination?.scope ?? GLOBAL_SCOPE;
    if (lesson.scope === to) throw new Error("Source and destination scopes must differ");
    const confirmed = await choose("Move lesson?", `#${lesson.id}: ${lesson.text}\n\nFrom: ${scopeLabel(lesson.scope)}\nTo: ${scopeLabel(to)}${global ? "\nGlobal lessons are recalled in every project using this database." : ""}\n\nMove this lesson and its entire linked replacement history, including any successor. IDs and metadata stay unchanged.\nUnrelated lessons stay put. Duplicate active text is refused. No files move.`,
      [CANCEL, item("move", "Move lesson")]);
    if (confirmed !== "move") return false;
    if (destination && (!statSync(destination.path).isDirectory() || projectScope(destination.path) !== to)) throw new Error("Destination changed; nothing moved");
    const current = viewState();
    const moved = current.store.moveLesson(current.scope, lesson.id, to, access.origin);
    access.refresh();
    ctx.ui.notify(`Moved lesson #${lesson.id} and linked history (${moved} records) to ${JSON.stringify(to)}.`, "info");
    return true;
  }

  async function globalLessons() {
    browsingScope = GLOBAL_SCOPE;
    try {
      while (true) {
        const action = await choose("Global lessons", "Shared across all projects using this database.",
          [item("active", "Active lessons"), item("add", "Add lesson"), item("archived", "Archived lessons"), BACK]);
        if (!action || action === "back") return;
        if (action === "add") await saveLesson();
        else await browse(action === "archived");
      }
    } finally { browsingScope = undefined; }
  }

  async function browseProjects() {
    while (true) {
      const scopes = access.current().store.listScopes().filter((scope) => scope !== GLOBAL_SCOPE);
      const scope = await projectPicker("All projects", scopes);
      if (!scope) return;
      browsingScope = scope;
      try {
        while (true) {
          const action = await choose("Project memories", scope, [item("active", "Active lessons"), item("archived", "Archived lessons"), BACK]);
          if (!action || action === "back") break;
          await browse(action === "archived");
        }
      } finally { browsingScope = undefined; }
    }
  }

  async function moveMemory() {
    const scopes = access.current().store.listScopes().filter((scope) => scope !== GLOBAL_SCOPE);
    const from = await projectPicker("Move memory — select stored cwd", scopes);
    if (!from) return;
    const entered = await projectDestination(from, true);
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
    const moved = access.current().store.moveScope(from, to, access.origin);
    access.refresh();
    ctx.ui.notify(`Moved ${moved} lessons to ${JSON.stringify(to)}.`, "info");
  }

  async function audit(): Promise<{ audit: { allProjects: boolean } } | undefined> {
    const { store: estimateStore, scope: estimateProject } = access.current();
    // A UUID-sized placeholder keeps the estimate aligned with the staged agent payload.
    const tokens = (allProjects: boolean) => formatTokens(Math.ceil(stagedAudit(
      estimateStore.auditSnapshot(estimateProject, allProjects), "00000000-0000-0000-0000-000000000000").length / 4));
    const scope = await choose("Audit memories — scope", "All active lessons, including those omitted from recall. Archived records stay excluded.\nToken estimates include the full audit text and metadata (characters/4); file exports can be smaller.",
      [item("current", `Current project + global (~${tokens(false)} tokens)`),
        item("all", `All projects + global (~${tokens(true)} tokens)`), CANCEL]);
    if (!scope || scope === "cancel") return;
    const output = await choose("Audit memories — output", "Request archive, priority, and global-scope recommendations with reasons. No changes without your approval.",
      [item("agent", "Send to agent"), item("file", "Export to file"), BACK]);
    if (!output || output === "back") return;
    let path: string | undefined;
    if (output === "file") {
      path = await ctx.ui.input("Audit export — new file path (relative to Pi cwd; existing files are never overwritten)", "memory-audit.md", { signal });
      access.check();
      if (!path?.trim()) return;
    }
    const confirmed = await choose(output === "agent" ? "Send audit to agent?" : "Export audit?", [
      scope === "all" ? "All stored projects + global (including missing project folders)." : `Current project: ${access.current().scope}\nGlobal lessons included.`,
      "Includes full lesson text, evidence, origins, dates, IDs, and priorities. No recall or command-output limits apply.",
      output === "agent" ? "Starts an agent turn; this data and project paths go to the selected model and remain in session history. Large audits may exceed its context window."
        : `Create private file: ${path}\nNo agent turn. The file contains memory data and project paths; keep it out of Git.`,
      "Recommendations only. Archive retains records; it is not deletion. Priority 0 is user-reserved.",
    ].join("\n\n"), [CANCEL, item("confirm", output === "agent" ? "Send to agent" : "Export")]);
    if (confirmed !== "confirm") return;
    const { store, scope: project } = access.current();
    if (output === "agent") return { audit: { allProjects: scope === "all" } };
    const written = writeAudit(ctx.cwd, path!, buildAudit(store, project, scope === "all"));
    ctx.ui.notify(`Audit exported to ${JSON.stringify(written)}. No memories changed.`, "info");
  }

  async function backups() {
    const manager = new Backups(access.current().path);
    let selected: string | undefined;
    while (true) {
      const settings = manager.settings();
      const action = await choose("Backups", `Auto backup: ${settings.frequency}\nFolder: ${settings.folder}\nAll projects, global lessons, and history. Backups are never automatically deleted.`, [
        item("frequency", "Auto backup…"), item("folder", "Backup folder…"), item("now", "Back up now"), item("stats", "Backup statistics"), BACK,
      ], selected);
      if (!action || action === "back") return;
      selected = action;
      try {
        if (action === "frequency") {
          const frequency = await choose("Auto backup", "Run at Pi startup when due. Local calendar periods; weeks start Monday.\nEnabling does not create a backup until the next startup; use Back up now for an immediate snapshot.",
            [...BACKUP_FREQUENCIES.map((value) => item(value, value[0].toUpperCase() + value.slice(1))), CANCEL], settings.frequency);
          if (frequency && frequency !== "cancel") manager.configure({ frequency: frequency as BackupFrequency });
        } else if (action === "folder") {
          const entered = await destinationInput(ctx, settings.folder, signal, "Backup folder — existing directory");
          access.check();
          if (entered === undefined) continue;
          const folder = backupFolder(ctx.cwd, entered);
          const confirmed = await choose("Change backup folder?", `New folder: ${folder}\nExisting backups stay where they are. Statistics and scheduling use the selected folder.`,
            [CANCEL, item("save", "Use this folder")]);
          if (confirmed === "save") manager.configure({ folder });
        } else if (action === "now") {
          ctx.ui.notify("Creating memory backup…", "info");
          const info = await manager.create();
          access.check();
          if (info) {
            let total: number | undefined;
            try { total = manager.stats().bytes; } catch { /* The snapshot succeeded even if folder statistics fail. */ }
            await choose("Backup created", backupReport(info, total), [BACK]);
          }
        } else if (action === "stats") {
          await choose("Backup statistics", backupStatsText(manager.stats()), [BACK]);
        }
      } catch (error) { access.check(); reportError(error); }
    }
  }

  async function status() {
    const lines = [`Config: ${JSON.stringify(access.configPath)}`, `Pi cwd: ${JSON.stringify(ctx.cwd)}`];
    try {
      const { store, path, scope, limits } = access.current();
      const page = store.recall(scope);
      const recalled = memoryContext(page, limits.maxRecallBytes);
      const globalPage = store.recall(GLOBAL_SCOPE);
      const global = memoryContext(globalPage, globalRecallBytes(limits.maxRecallBytes), "GLOBAL LESSONS");
      lines.push(`Project scope: ${JSON.stringify(scope)}`, `Database: ${JSON.stringify(path)}`,
        `Active: ${page.total} · Loaded: ${recalled.loaded} · Omitted: ${page.total - recalled.loaded}`,
        `Archived: ${store.list(scope, { state: "archived", limit: 1 }).total}`,
        `Lesson limit: ${limits.maxLessonWords} words · Evidence limit: ${limits.maxEvidenceWords} words`,
        `Recall limit: ${limits.maxRecallLessons} lessons or ${limits.maxRecallBytes / 1024} KiB, whichever fills first.`,
        `Global: ${globalPage.total} active · ${global.loaded} loaded · ${globalPage.total - global.loaded} omitted · ${store.list(GLOBAL_SCOPE, { state: "archived", limit: 1 }).total} archived`,
        `Separate global recall limit: ${limits.maxRecallLessons} lessons or ${globalRecallBytes(limits.maxRecallBytes) / 1024} KiB.`,
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
      const globalPage = state.store.recall(GLOBAL_SCOPE);
      const globalRecalled = memoryContext(globalPage, globalRecallBytes(state.limits.maxRecallBytes), "GLOBAL LESSONS");
      const candidates = state.store.candidateCounts();
      summary = `${page.total} active · ${recalled.loaded} loaded into context (project)\nGlobal: ${globalPage.total} active · ${globalRecalled.loaded} loaded into context\n🌱 ${candidates.pending} pending candidates · ${candidates.sinceEvaluation} new since last completed evaluation (all projects)`;
      if (!page.total) summary += "\nNo project lessons yet. Add a lesson.";
    } catch (error) { state = undefined; summary = `Memory unavailable: ${errorText(error)}`; }
    const action = await choose(`Memory · ${basename(state?.scope ?? ctx.cwd)}`, summary, [
      ...(state ? [item("browse", "Browse / search lessons"), item("add", "Add lesson"), item("archived", "Archived lessons"),
        item("global", "Global lessons"), item("projects", "All projects"), item("evaluate", "Evaluate candidates…"), item("audit", "Audit…"), item("move", "Move memory"), item("backups", "Backups…")] : []),
      item("status", "Status & limits"), item("reload", "Reload memory"), item("help", "Help"),
    ], selected);
    if (!action) return;
    selected = action;
    if (action === "reload") return "reload";
    if (action === "evaluate") {
      const candidates = access.current().store.candidateCounts();
      const confirmed = await choose("Evaluate candidates", `${candidates.pending} pending candidates across all projects.\nSend every candidate, evidence, submission date, and previous grouping to the current model.\nThe evaluation is retained in this conversation. Nothing is promoted without individual approval.`,
        [CANCEL, item("send", "Send to current model")]);
      if (confirmed === "send") return "evaluate";
      continue;
    }
    try {
      if (action === "status") await status();
      else if (action === "help") await choose("Memory help", access.help + "\n\nBrowsing stays in the UI; only a confirmed audit sends lessons to the agent.\nReplace and archive retain records. There is no restore or delete.", [BACK]);
      else if (action === "browse" || action === "archived") await browse(action === "archived");
      else if (action === "global") await globalLessons();
      else if (action === "projects") await browseProjects();
      else if (action === "add") await saveLesson();
      else if (action === "move") await moveMemory();
      else if (action === "backups") await backups();
      else if (action === "audit") {
        const result = await audit();
        if (result) return result;
      }
    } catch (error) { access.check(); reportError(error); }
  }
}
