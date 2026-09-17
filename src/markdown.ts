import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isInside } from "./project.ts";
import { checkedText, checkNew, MAX_TEXT, type MemoryStore, type Origin } from "./store.ts";
import type { MemoryLimits } from "./limits.ts";

export const MAX_IMPORT_BYTES = 1024 * 1024;
export interface MarkdownSource {
  path: string;
  realpath: string;
  text: string;
  sha256: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}
export interface ImportPreview {
  source: MarkdownSource;
  markdown: string;
  texts: string[];
  sha256: string;
}

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

export function readMarkdownSource(scope: string, cwd: string, file: string): MarkdownSource {
  const path = resolve(cwd, file);
  const realpath = realpathSync(path);
  if (!isInside(scope, realpath)) throw new Error("Import source must be inside the current project");
  // Nonblocking open lets fstat reject FIFOs/devices without freezing the Pi event loop.
  const fd = openSync(realpath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_IMPORT_BYTES) throw new Error("Import requires a regular file no larger than 1 MiB");
    const buffer = Buffer.alloc(MAX_IMPORT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_IMPORT_BYTES) throw new Error("Import source grew beyond 1 MiB");
    bytes = buffer.subarray(0, size);
    const after = fstatSync(fd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
      throw new Error("Memory file changed while reading; retry");
    }
    return { path, realpath, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } finally {
    closeSync(fd);
  }
}

export function assertSourceUnchanged(scope: string, source: MarkdownSource): void {
  const now = readMarkdownSource(scope, scope, source.path);
  if (now.realpath !== source.realpath || now.sha256 !== source.sha256 || now.dev !== source.dev || now.ino !== source.ino ||
      now.mtimeMs !== source.mtimeMs || now.ctimeMs !== source.ctimeMs) {
    throw new Error("Memory file changed since preview; nothing further changed. Run /memory import again");
  }
}

export function prepareImport(source: MarkdownSource, markdown: string, limits: Readonly<MemoryLimits>): ImportPreview {
  if (Buffer.byteLength(markdown) > MAX_IMPORT_BYTES) throw new Error("Import draft exceeds 1 MiB");
  const texts = parseMarkdown(markdown).map((text) => checkNew({
    text, evidence: `sha256:${source.sha256}`, basis: "import",
  }, limits).text);
  // Show exactly the text that will be stored, including whitespace normalization.
  const normalized = "# Project memory\n\n" + texts.map((text) => "- " + text.replaceAll("\n", "\n  ")).join("\n") + "\n";
  return { source, markdown: normalized, texts, sha256: createHash("sha256").update(normalized).digest("hex") };
}

function saveImport(store: MemoryStore, scope: string, source: MarkdownSource, texts: string[], origin: Origin) {
  const imported = store.addMany(scope, texts.map((text) => ({
    text, evidence: `sha256:${source.sha256}`, basis: "import" as const,
  })), origin);
  return {
    source: source.path, sha256: source.sha256, imported: imported.filter((item) => item.created).length,
    existing: imported.filter((item) => !item.created).length,
    archived: imported.filter((item) => item.lesson.archived).length,
    ids: imported.map((item) => item.lesson.id),
    sourceRetained: true,
  };
}

export function commitImport(store: MemoryStore, scope: string, preview: ImportPreview, origin: Origin) {
  // Save the approved immutable snapshot. This detects stale sources, not an atomic filesystem/SQLite transaction.
  assertSourceUnchanged(scope, preview.source);
  return { ...saveImport(store, scope, preview.source, preview.texts, origin), draftSha256: preview.sha256 };
}

/** Low-level noninteractive API; the Pi command adds the review/approval boundary. */
export function importMarkdown(store: MemoryStore, scope: string, cwd: string, file: string, origin: Origin) {
  const source = readMarkdownSource(scope, cwd, file);
  return saveImport(store, scope, source, parseMarkdown(source.text), origin);
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
