import { DEFAULT_LIMITS } from "./limits.ts";
import type { Lesson, Page, RecallPage } from "./store.ts";

export const RESULT_BYTES = 16384;

/** Render terminal controls and invisible formatting visibly in human-facing screens. */
export function visible(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, (character) => {
    const code = character.codePointAt(0)!;
    return code <= 0xffff ? `\\u${code.toString(16).padStart(4, "0")}` : `\\u{${code.toString(16)}}`;
  });
}

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
export function memoryContext(page: RecallPage, maxBytes = DEFAULT_LIMITS.maxRecallBytes): { text: string; loaded: number; loadedIds: number[] } {
  const rows: Array<Pick<Lesson, "id" | "text">> = [];
  const render = () => [
    "PROJECT LESSONS",
    ...rows.map((row) => `- ${row.text.replace(/\s+/gu, " ")} #${row.id}`),
    ...(rows.length < page.total ? [`[${page.total - rows.length} lessons omitted.]`] : []),
  ].join("\n");
  for (const row of page.lessons) {
    rows.push({ id: row.id, text: row.text });
    if (Buffer.byteLength(render()) > maxBytes) {
      rows.pop();
      break;
    }
  }
  return { text: render(), loaded: rows.length, loadedIds: rows.map((row) => row.id) };
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
