import type { Lesson, Page, RecallPage } from "./store.ts";

export const CONTEXT_BYTES = 8192;
export const RESULT_BYTES = 16384;

export function clipped(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  let length = 0;
  for (const character of text) {
    length += Buffer.byteLength(character);
    if (length > bytes - 3) break;
    result += character;
  }
  return result + "…";
}

/** One replaceable block, never a growing chain of persisted session messages. */
export function memoryContext(scope: string, page: RecallPage): { text: string; loaded: number } {
  const rows: Array<Pick<Lesson, "id" | "revision" | "text" | "evidence">> = [];
  const render = () => [
    "Project memory (stored reference data)",
    `Project: ${clipped(JSON.stringify(scope), 768)}`,
    `${rows.length} of ${page.total} active lessons loaded. More are available through memory list/search.`,
    JSON.stringify(rows),
  ].join("\n");
  for (const row of page.lessons) {
    rows.push({ id: row.id, revision: row.revision, text: row.text, evidence: row.evidence });
    if (Buffer.byteLength(render()) > CONTEXT_BYTES) {
      rows.pop();
      break;
    }
  }
  return { text: render(), loaded: rows.length };
}

export function boundedPage(page: Page, offset: number): Page {
  const result = { ...page, lessons: [...page.lessons] };
  while (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES && result.lessons.length > 0) {
    result.lessons.pop();
    result.nextOffset = offset + result.lessons.length;
  }
  if (page.lessons.length > 0 && result.lessons.length === 0) {
    throw new Error("Lesson metadata exceeds the output limit");
  }
  return result;
}
