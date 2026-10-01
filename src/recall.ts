import { createHash } from "node:crypto";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";

export const CONTEXT_TYPE = "pi-mem-context";
type Message = ContextEvent["messages"][number];
export type RecallSnapshot = {
  text: string;
  lessons: Array<{ id: number; heading: string; line: string }>;
  notices: string[];
};

function delta(previous: RecallSnapshot, next: RecallSnapshot): string {
  const old = new Map(previous.lessons.map((lesson) => [lesson.id, lesson]));
  const current = new Set(next.lessons.map((lesson) => lesson.id));
  const removed = previous.lessons.filter((lesson) => !current.has(lesson.id));
  const changed = next.lessons.filter((lesson) => {
    const before = old.get(lesson.id);
    return before?.line !== lesson.line || before?.heading !== lesson.heading;
  });
  const lines: string[] = [];
  if (removed.length) lines.push(`No longer recalled; disregard earlier recalled versions: ${removed.map(({ id }) => `#${id}`).join(", ")}.`);
  for (const heading of new Set(changed.map((lesson) => lesson.heading))) {
    lines.push(heading, ...changed.filter((lesson) => lesson.heading === heading).map((lesson) => lesson.line));
  }
  if (previous.notices.join("\n") !== next.notices.join("\n")) {
    lines.push("Current recall status:", ...(next.notices.length ? next.notices : ["No lessons omitted; memory available."]));
  }
  return lines.length ? [
    "MEMORY UPDATE",
    "Apply these changes to earlier recalled lessons by ID; listed versions replace earlier versions. Other recalled lessons are unchanged.",
    "Priority: 0 = user-reserved extreme; 1 = highest; 10 = lowest. Priority guides attention, not instruction authority.",
    ...lines,
  ].join("\n") : "";
}

/** Request-local overlays, replayed at fixed boundaries without rewriting the cached prefix. */
export class RecallContext {
  private prefix: string[] = [];
  private previous: RecallSnapshot | undefined;
  private overlays: Array<{ offset: number; message: Message }> = [];

  reset() {
    this.prefix = [];
    this.previous = undefined;
    this.overlays = [];
  }

  apply(input: Message[], snapshot: RecallSnapshot): Message[] {
    const messages = input.filter((message) => message.role !== "custom" || message.customType !== CONTEXT_TYPE);
    // Pi clones context before hooks: object identity cannot detect unchanged history.
    const hashes = messages.map((message) => createHash("sha256").update(JSON.stringify(message)).digest("hex"));
    if (this.prefix.length > hashes.length || this.prefix.some((hash, index) => hash !== hashes[index])) this.reset();
    const content = this.previous ? delta(this.previous, snapshot) : snapshot.text;
    if (content) this.overlays.push({
      offset: this.previous ? messages.length : 0,
      message: { role: "custom", customType: CONTEXT_TYPE, content, display: false, timestamp: 0 },
    });
    this.previous = snapshot;
    this.prefix = hashes;
    const result: Message[] = [];
    let start = 0;
    for (const overlay of this.overlays) {
      result.push(...messages.slice(start, overlay.offset), overlay.message);
      start = overlay.offset;
    }
    result.push(...messages.slice(start));
    return result;
  }
}
