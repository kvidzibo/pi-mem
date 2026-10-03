import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { GLOBAL_SCOPE, MemoryStore } from "./src/store.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
type Event = { type: string; id?: string; method?: string; message?: string; notifyType?: string;
  title?: string; prefill?: string; options?: string[]; statusKey?: string; statusText?: string;
  entry?: { customType: string; data: unknown } };

test("real offline Pi processes save, reload across sessions, and isolate projects without model calls", { timeout: 90000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-mem-rpc-")));
  const project = join(directory, "project");
  const other = join(directory, "other");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(other);
  execFileSync("git", ["init", "--quiet", project]);
  execFileSync("git", ["init", "--quiet", other]);
  const { RpcClient } = await import(pathToFileURL(join(DIST, "modes/rpc/rpc-client.js")).href);
  // Pi's RPC client merges environment overrides, so explicitly empty inherited keys.
  // The child must never see the developer's provider credentials or runtime config.
  const env = {
    ...Object.fromEntries(Object.keys(process.env).map((key) => [key, ""])),
    PATH: process.env.PATH ?? "",
    HOME: directory,
    USERPROFILE: directory,
    PI_CODING_AGENT_DIR: join(directory, "agent"),
    PI_MEMORY_DB: join(directory, "lessons.sqlite3"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  const options = {
    cliPath: join(DIST, "bundle/cli.js"), env,
    args: ["--offline", "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions", "-e", join(ROOT, "src/index.ts")],
  };
  const events: Event[] = [];
  const saveCards = () => events.filter((event) => event.type === "entry_appended" && event.entry?.customType === "pi-mem-saved");
  const memoryStatus = () => stripVTControlCharacters(events.filter((event) => event.method === "setStatus" && event.statusKey === "pi-mem").at(-1)?.statusText ?? "");
  let client = new RpcClient({ ...options, cwd: join(project, "src") });
  let browseMenu = false;
  let browseRootSeen = false;
  let detailDone = false;
  let browseStage = 0;
  let priorityChosen = false;
  let menuClosed: (() => void) | undefined;
  let adding = false;
  let inputOpened: (() => void) | undefined;
  let staleInputId: string | undefined;
  const listen = () => client.onEvent((event: Event) => {
    events.push(event);
    if (event.type !== "extension_ui_request") return;
    let value: string | undefined;
    if (event.method === "input" && adding) {
      assert.match(event.title!, /^Add lesson/);
      assert.ok(event.title!.includes(`Project: ${project}`));
      staleInputId = event.id;
      inputOpened?.();
      return; // Leave this input pending, then abort it through /pi-mem reload.
    }
    if (event.method === "select") {
      if (adding && event.title?.startsWith("Memory ·")) {
        value = "Add lesson";
      } else if (browseMenu && event.title?.startsWith("Memory ·")) {
        assert.match(event.title, /Memory · (project|other)/);
        if (browseRootSeen) {
          client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
          menuClosed?.();
          return;
        }
        browseRootSeen = true;
        assert.equal(event.options?.length, 10);
        assert.deepEqual(event.options?.slice(0, 3), ["Browse / search lessons", "Add lesson", "Archived lessons"]);
        value = "Browse / search lessons";
      } else if (browseMenu && event.title?.startsWith("Browse / search lessons")) {
        if (detailDone) value = "Back";
        else if (browseStage++ === 0) value = "Not recalled only";
        else if (browseStage === 2) {
          assert.match(event.title, /Filter: Not recalled[\s\S]*No lessons found/);
          assert.ok(!event.options?.some((option) => option.includes("A verified lesson from the RPC smoke test")));
          value = "Show all active lessons";
        } else {
          assert.ok(event.options?.some((option) => /^#\d+ · \[P5\]/.test(option) && option.includes("A verified lesson from the RPC smoke test")));
          value = event.options!.find((option) => option.includes("A verified lesson from the RPC smoke test"));
        }
      } else if (browseMenu && event.title?.startsWith("Lesson details")) {
        assert.match(event.title, /A verified lesson from the RPC smoke test/);
        assert.ok(event.title!.includes(`Project: ${project}`));
        assert.ok(event.options?.includes("Archive"));
        assert.ok(!event.options?.includes("Delete (archive)"));
        if (!priorityChosen) value = "Change priority…";
        else {
          assert.match(event.title, /Priority: 3/);
          detailDone = true;
          client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, cancelled: true }) + "\n");
          return;
        }
      } else if (browseMenu && event.title?.startsWith("Lesson priority")) {
        assert.ok(event.title.includes(`Project: ${project}`));
        assert.match(event.title, /Current priority: 5/);
        value = "3";
        priorityChosen = true;
      } else {
        value = event.options![0];
      }
    }
    if (value !== undefined) {
      // RpcClient has no public dialog-response helper; exercise the documented JSONL response directly.
      client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value }) + "\n");
    }
  });
  const command = async (text: string) => {
    const start = events.length;
    await client.prompt(text);
    const reports = events.slice(start).filter((event) => event.type === "extension_ui_request" && event.method === "notify");
    assert.ok(reports.length > 0, `no command report: ${client.getStderr()}`);
    assert.ok(reports.every((event) => event.notifyType !== "error"), JSON.stringify(reports));
    return reports.at(-1)!.message!;
  };
  try {
    listen();
    await client.start();
    assert.ok((await client.getCommands()).some((cmd: { name: string }) => cmd.name === "pi-mem"));
    const saved = JSON.parse(await command("/pi-mem add A verified lesson from the RPC smoke test."));
    assert.equal(saved.status, "saved");
    assert.equal(saved.scope, project);
    assert.match(memoryStatus(), /^ 🧠 1\|0 \(\+1\) ~/);
    assert.deepEqual(saveCards().map((event) => event.entry!.data), [[{ id: saved.id, text: "A verified lesson from the RPC smoke test.", supersedes_id: null }]]);
    assert.deepEqual(await client.getMessages(), [], "chat-only save entries must not become model messages");
    assert.equal(JSON.parse(await command("/pi-mem add A verified lesson from the RPC smoke test.")).status, "already exists");
    await command("/pi-mem reload");
    assert.equal(saveCards().length, 1, "duplicates and reload must not repeat save entries");
    assert.match(memoryStatus(), /^ 🧠 1\|0 \(\+1\) ~/);

    const before = await client.getState();
    assert.equal((await client.newSession()).cancelled, false);
    assert.notEqual((await client.getState()).sessionId, before.sessionId);
    assert.match(memoryStatus(), /^ 🧠 1\|0 ~/, "new sessions must not count earlier sessions' writes");
    const messagesBeforeBrowse = await client.getMessages();
    browseMenu = true;
    browseRootSeen = false;
    detailDone = false;
    const closed = new Promise<void>((resolve) => { menuClosed = resolve; });
    await client.prompt("/pi-mem");
    await closed; // Prompt acceptance is not completion of an extension's dialog sequence.
    browseMenu = false;
    const messagesAfterBrowse = await client.getMessages();
    assert.deepEqual(messagesAfterBrowse, messagesBeforeBrowse, "browsing must not add messages");
    assert.equal(JSON.parse(await command(`/pi-mem get ${saved.id}`)).priority, 3);
    assert.equal(events.filter((event) => event.type === "agent_start").length, 0);
    assert.match(events.find((event) => event.title?.startsWith("Lesson details"))?.title ?? "", /A verified lesson from the RPC smoke test/);

    // A pending RPC lesson input must unwind on reload without blocking or overlapping a later menu.
    adding = true;
    const opened = new Promise<void>((resolve) => { inputOpened = resolve; });
    const pendingAdd = client.prompt("/pi-mem");
    await opened;
    assert.ok(staleInputId);
    await command("/pi-mem reload");
    await pendingAdd;
    adding = false;
    browseMenu = true;
    browseRootSeen = true;
    const reopened = new Promise<void>((resolve) => { menuClosed = resolve; });
    await client.prompt("/pi-mem");
    await reopened;
    browseMenu = false;
    client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: staleInputId, value: "Must not save stale text." }) + "\n");
    assert.equal(JSON.parse(await command("/pi-mem search Must not save stale text.")).total, 0);
    assert.equal(JSON.parse(await command("/pi-mem list")).total, 1);
    assert.deepEqual(await client.getMessages(), messagesBeforeBrowse);
    const replacement = JSON.parse(await command(`/pi-mem supersede ${saved.id} A verified lesson from the RPC smoke test.`));
    assert.match(memoryStatus(), /^ 🧠 1\|0 \(\+1 -1\) ~/, "superseding adds one and archives one in the current session");
    assert.equal(JSON.parse(await command(`/pi-mem archive ${saved.id}`)).changed, false);
    await command("/pi-mem reload");
    assert.match(memoryStatus(), /^ 🧠 1\|0 \(\+1 -1\) ~/);
    assert.equal(saveCards().length, 2);
    await client.stop();
    client = new RpcClient({ ...options, cwd: project });
    listen();
    await client.start();
    assert.match(await command("/pi-mem reload"), /A verified lesson from the RPC smoke test/);
    assert.equal(JSON.parse(await command("/pi-mem list")).total, 1);
    assert.equal(JSON.parse(await command(`/pi-mem archive ${replacement.id}`)).changed, true);
    assert.match(memoryStatus(), /^ 🧠 0\|0 \(-1\) ~/, "a fresh session counts only its explicit archive");
    const archiveCards = () => events.filter((event) => event.type === "entry_appended" && event.entry?.customType === "pi-mem-archived");
    assert.equal(archiveCards().length, 1);
    assert.deepEqual(archiveCards()[0].entry!.data, { id: replacement.id, text: "A verified lesson from the RPC smoke test.",
      scope: project, database: env.PI_MEMORY_DB, session: (await client.getState()).sessionId });
    assert.equal(JSON.parse(await command(`/pi-mem archive ${replacement.id}`)).changed, false);
    await command("/pi-mem reload");
    assert.match(memoryStatus(), /^ 🧠 0\|0 \(-1\) ~/);
    assert.equal(archiveCards().length, 1);
    assert.deepEqual(await client.getMessages(), [], "archive activity must not become model messages");
    await client.stop();
    client = new RpcClient({ ...options, cwd: other });
    listen();
    await client.start();
    browseMenu = true;
    browseRootSeen = true;
    const emptyClosed = new Promise<void>((resolve) => { menuClosed = resolve; });
    await client.prompt("/pi-mem");
    await emptyClosed;
    browseMenu = false;
    const emptyMenu = events.find((event) => event.method === "select" && event.title?.startsWith("Memory · other"));
    assert.ok(emptyMenu);
    assert.match(emptyMenu!.title!, /0 active · 0 loaded into context/);
    assert.deepEqual(emptyMenu!.options, ["Browse / search lessons", "Add lesson", "Archived lessons", "Global lessons", "All projects", "Audit…", "Move memory", "Status & limits", "Reload memory", "Help"]);
    const recalled = await command("/pi-mem reload");
    assert.doesNotMatch(recalled, /A verified lesson from the RPC smoke test/);
    assert.match(recalled, /^Database: .+\nPROJECT LESSONS$/);
    assert.equal(events.filter((event) => event.type === "agent_start" || event.type === "extension_error").length, 0);
  } finally {
    await client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real offline audit tool asks once and applies all scopes only after RPC approval", { timeout: 30000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "pi-mem-audit-rpc-")));
  const project = join(directory, "project"), other = join(directory, "other");
  mkdirSync(project); mkdirSync(other);
  const database = join(directory, "lessons.sqlite3");
  const store = new MemoryStore(database);
  const source = { harness: "test", session: null, actor: "user" as const };
  const add = (scope: string, text: string) => store.add(scope, { text, evidence: "Verified", basis: "user_request" }, source).lesson;
  const archived = add(project, "Audit archive");
  const ranked = add(GLOBAL_SCOPE, "Audit ranking");
  const moved = add(other, "Audit shared guidance");
  // Deterministic in-process provider: exercise Pi's real schema/execute pipeline, never call a network or live model.
  const provider = join(directory, "provider.ts");
  writeFileSync(provider, `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  const seen = new Set(); let round = 0;
  pi.registerProvider("audit-test", { api: "audit-test-api", baseUrl: "https://example.invalid", apiKey: "test-only",
    models: [{ id: "audit", name: "Offline audit", reasoning: false, input: ["text"],
      contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const text = context.messages.map(m => typeof m.content === "string" ? m.content :
        (Array.isArray(m.content) ? m.content.filter(p => p.type === "text").map(p => p.text).join("\\n") : ""))
        .filter(s => s.includes("with auditId")).at(-1) || "";
      const token = /with auditId ("[^"]+")/.exec(text);
      const auditId = token ? JSON.parse(token[1]) : undefined;
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0,
          cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "start", partial: message });
      if (auditId && !seen.has(auditId)) {
        seen.add(auditId); round++;
        const changes = round === 1 ? [
          { id: ${archived.id}, action: "archive", reason: "Low value" },
          { id: ${ranked.id}, action: "set_priority", priority: 3, reason: "Recurring failures" },
          { id: ${moved.id}, action: "move_global", reason: "Cross-project guidance" }
        ] : [{ id: ${ranked.id}, action: "set_priority", priority: round === 2 ? 4 : true, reason: "Review priority" }];
        const call = { type: "toolCall", id: "audit-call-" + round, name: "memory_audit", arguments: { auditId, changes } };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = "toolUse";
      } else {
        message.content.push({ type: "text", text: "Audit finished." }); message.stopReason = "stop";
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "Audit finished.", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "Audit finished.", partial: message });
      }
      stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); return stream;
    }
  });
}
`);
  const { RpcClient } = await import(pathToFileURL(join(DIST, "modes/rpc/rpc-client.js")).href);
  const client = new RpcClient({ cliPath: join(DIST, "bundle/cli.js"), cwd: project, provider: "audit-test", model: "audit",
    env: { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, ""])), PATH: process.env.PATH ?? "",
      HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: join(directory, "agent"), PI_MEMORY_DB: database,
      PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    args: ["--offline", "--no-approve", "--no-context-files", "--no-skills", "--no-prompt-templates", "--no-extensions",
      "-e", join(ROOT, "src/index.ts"), "-e", provider] });
  const events: any[] = [];
  let choice = "Apply all";
  let ended: (() => void) | undefined;
  client.onEvent((event: any) => {
    events.push(event);
    if (event.type === "agent_end") ended?.();
    if (event.type === "extension_ui_request" && event.method === "select") {
      assert.match(event.title, /^Review memory audit/);
      assert.deepEqual(event.options, ["Cancel", "Apply all"]);
      assert.match(event.title, /cannot be restored/);
      client.process.stdin.write(JSON.stringify({ type: "extension_ui_response", id: event.id, value: choice }) + "\n");
    }
  });
  const audit = async () => {
    const start = events.length;
    const finished = new Promise<void>((resolve) => { ended = resolve; });
    await client.prompt("/pi-mem audit --all-projects");
    await finished;
    return events.slice(start);
  };
  try {
    await client.start();
    const approved = await audit();
    const review = approved.find((event) => event.method === "select");
    assert.match(review.title, /3 changes: 1 archives · 1 priority changes · 1 moves to global/);
    assert.ok(review.title.includes(other));
    assert.match(review.title, /Cross-project guidance/);
    assert.equal(store.get(project, archived.id).archived, true);
    assert.equal(store.get(GLOBAL_SCOPE, ranked.id).priority, 3);
    assert.equal(store.get(GLOBAL_SCOPE, moved.id).scope, GLOBAL_SCOPE);
    const history = store.history(GLOBAL_SCOPE, moved.id).events[0];
    assert.equal(history.actor, "user"); assert.equal(history.provider, "audit-test"); assert.equal(history.model, "audit");
    assert.ok(approved.some((event) => event.type === "tool_execution_end" && !event.isError && event.result.details.status === "applied"));
    choice = "Cancel";
    const declined = await audit();
    assert.equal(declined.filter((event) => event.method === "select").length, 1);
    assert.equal(store.get(GLOBAL_SCOPE, ranked.id).priority, 3);
    assert.ok(declined.some((event) => event.type === "tool_execution_end" && event.result.details.status === "cancelled"));
    const invalid = await audit();
    assert.equal(invalid.filter((event) => event.method === "select").length, 0, "boolean priorities must fail before schema coercion and approval");
    assert.ok(invalid.some((event) => event.type === "tool_execution_end" && event.isError && /priority must/.test(JSON.stringify(event.result))));
    assert.equal(store.get(GLOBAL_SCOPE, ranked.id).priority, 3);
    assert.ok(!events.some((event) => event.type === "extension_error"), client.getStderr());
  } finally { await client.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
