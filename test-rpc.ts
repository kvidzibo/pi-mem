import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DIST = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
type Event = { type: string; method?: string; message?: string; notifyType?: string };

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
  let client = new RpcClient({ ...options, cwd: join(project, "src") });
  const listen = () => client.onEvent((event: Event) => events.push(event));
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
    assert.ok((await client.getCommands()).some((cmd: { name: string }) => cmd.name === "memory"));
    const saved = JSON.parse(await command("/memory add A verified lesson from the RPC smoke test."));
    assert.equal(saved.status, "saved");
    assert.equal(saved.scope, project);
    const before = await client.getState();
    assert.equal((await client.newSession()).cancelled, false);
    assert.notEqual((await client.getState()).sessionId, before.sessionId);
    assert.match(await command("/memory"), /A verified lesson from the RPC smoke test/);
    await client.stop();
    client = new RpcClient({ ...options, cwd: project });
    listen();
    await client.start();
    assert.match(await command("/memory reload"), /A verified lesson from the RPC smoke test/);
    await client.stop();
    client = new RpcClient({ ...options, cwd: other });
    listen();
    await client.start();
    const recalled = await command("/memory");
    assert.doesNotMatch(recalled, /A verified lesson from the RPC smoke test/);
    assert.match(recalled, /0 of 0 active lessons/);
    assert.equal(events.filter((event) => event.type === "agent_start" || event.type === "extension_error").length, 0);
  } finally {
    await client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
