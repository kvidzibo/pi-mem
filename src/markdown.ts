import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isInside } from "./project.ts";
import { checkedText, MAX_TEXT, type MemoryStore, type Origin } from "./store.ts";

/** Deliberately strict: never silently discard prose during a migration. */
export function parseMarkdown(markdown: string): string[] {
  const items: string[] = [];
  let current: string[] | undefined;
  const flush = () => {
    if (current) items.push(checkedText(current.join("\n"), "imported lesson", MAX_TEXT));
    current = undefined;
  };
  for (const [index, line] of markdown.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const bullet = /^(?:[-*+] |\d+[.)] )(.*)$/.exec(line);
    if (bullet) {
      flush();
      current = [bullet[1]];
    } else if (/^ {2}/.test(line) && current) {
      current.push(line.slice(2));
    } else if (!line.trim()) {
      if (current) current.push("");
    } else if (/^# /.test(line) && !current && items.length === 0) {
      // Optional document title, not a lesson.
    } else {
      throw new Error(`Unsupported Markdown at line ${index + 1}; use top-level bullets with two-space-indented continuations`);
    }
  }
  flush();
  if (!items.length || items.length > 500) throw new Error("Import requires 1–500 bulleted lessons");
  return items;
}

export function importMarkdown(store: MemoryStore, scope: string, cwd: string, file: string, origin: Origin) {
  const source = realpathSync(resolve(cwd, file));
  if (!isInside(scope, source)) throw new Error("Import source must be inside the current project");
  // Nonblocking open lets fstat reject FIFOs/devices without freezing the Pi event loop.
  const fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Import requires a regular file no larger than 1 MiB");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > 1024 * 1024) throw new Error("Import source grew beyond 1 MiB");
    bytes = buffer.subarray(0, size);
  } finally {
    closeSync(fd);
  }
  const texts = parseMarkdown(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const hash = createHash("sha256").update(bytes).digest("hex");
  const imported = store.addMany(scope, texts.map((text) => ({
    text,
    evidence: `Imported from ${basename(source)}; sha256:${hash}`,
    basis: "import" as const,
  })), origin);
  return {
    source, sha256: hash, imported: imported.filter((item) => item.created).length,
    existing: imported.filter((item) => !item.created).length,
    archived: imported.filter((item) => item.lesson.archived).length,
    ids: imported.map((item) => item.lesson.id),
    sourceRetained: true,
  };
}

export function exportPath(scope: string, cwd: string, file: string): string {
  const requested = resolve(cwd, file);
  // Canonicalize the parent; the output itself must not exist, including symlinks.
  const output = join(realpathSync(dirname(requested)), basename(requested));
  if (!isInside(scope, output)) throw new Error("Export destination must be inside the current project");
  return output;
}

export function exportMarkdown(store: MemoryStore, scope: string, output: string): number {
  // Exports are snapshots of active lesson text; provenance stays in SQLite.
  output = exportPath(scope, scope, output);
  const texts = store.activeTexts(scope);
  const lines = ["# Project memory", ""];
  for (const text of texts) lines.push("- " + text.replaceAll("\n", "\n  "), "");
  writeFileSync(output, lines.join("\n"), { flag: "wx", mode: 0o600 });
  return texts.length;
}
