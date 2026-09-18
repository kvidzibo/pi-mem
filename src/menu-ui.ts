import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, SelectList, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { visible } from "./presentation.ts";

export const words = (text: string) => text.trim() ? text.trim().split(/\s+/u).length : 0;

/** A scrollable read-only body and keyboard selector. Never writes a session message. */
export async function menuChoice(ctx: ExtensionContext, title: string, body: string, items: SelectItem[],
  signal: AbortSignal, selected?: string): Promise<string | undefined> {
  signal.throwIfAborted();
  const safeItems = items.map((item) => ({ ...item, label: visible(item.label).replace(/\n/g, " "),
    description: item.description ? visible(item.description).replace(/\n/g, " ") : undefined }));
  if (ctx.mode !== "tui") {
    // RPC can render a select dialog, but not custom components. Labels must be unique.
    const labels = safeItems.map((item) => item.label);
    const choice = await ctx.ui.select(visible([title, body].filter(Boolean).join("\n\n")), labels, { signal });
    signal.throwIfAborted();
    return safeItems.find((item) => item.label === choice)?.value;
  }
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    let index = Math.max(0, items.findIndex((item) => item.value === selected));
    let offset = 0;
    let bodyHeight = 1;
    let bodyRows: string[] = [];
    let listHeight = 1;
    let finished = false;
    const finish = (value?: string) => { if (!finished) { finished = true; done(value); } };
    const cancel = () => finish();
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) queueMicrotask(cancel);
    const key = (id: Parameters<typeof keys.getKeys>[0]) => keys.getKeys(id).join("/");
    return {
      render(width: number) {
        const w = Math.max(1, width);
        // Rebuild with the callback theme on every render, including after theme/size changes.
        bodyRows = body ? visible(body).split("\n").flatMap((line) => wrapTextWithAnsi(line, w)) : [];
        const height = Math.max(6, tui.terminal.rows - 5);
        listHeight = Math.max(1, Math.min(items.length, 10, Math.floor((height - 3) / (body ? 2 : 1))));
        bodyHeight = Math.max(0, height - listHeight - 4);
        offset = Math.max(0, Math.min(offset, bodyRows.length - bodyHeight));
        const list = new SelectList(safeItems, listHeight, {
          selectedPrefix: (s) => theme.fg("accent", s), selectedText: (s) => theme.fg("accent", s),
          description: (s) => theme.fg("muted", s), scrollInfo: (s) => theme.fg("dim", s), noMatch: (s) => s,
        });
        list.setSelectedIndex(index);
        const scrolling = bodyRows.length > bodyHeight;
        const scrollHint = scrolling ? ` · ${key("tui.select.pageUp")}/${key("tui.select.pageDown")} scroll text` : "";
        return [
          theme.fg("accent", theme.bold(visible(title).replace(/\n/g, " "))),
          ...bodyRows.slice(offset, offset + bodyHeight),
          ...(scrolling ? [theme.fg("dim", `Text ${offset + 1}–${offset + bodyHeight}/${bodyRows.length}${scrollHint}`)] : []),
          ...list.render(Math.max(5, w)),
          theme.fg("dim", `${key("tui.select.up")}/${key("tui.select.down")} navigate · ${key("tui.select.confirm")} select · ${key("tui.select.cancel")} back`),
        ].map((line) => truncateToWidth(line, w));
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) return finish();
        if (keys.matches(data, "tui.select.confirm")) return finish(items[index]?.value);
        if (keys.matches(data, "tui.select.up")) index = (index + items.length - 1) % items.length;
        else if (keys.matches(data, "tui.select.down")) index = (index + 1) % items.length;
        else if (keys.matches(data, "tui.select.pageUp")) {
          if (bodyRows.length > bodyHeight) offset -= Math.max(1, bodyHeight);
          else index = Math.max(0, index - listHeight);
        } else if (keys.matches(data, "tui.select.pageDown")) {
          if (bodyRows.length > bodyHeight) offset += Math.max(1, bodyHeight);
          else index = Math.min(items.length - 1, index + listHeight);
        }
        tui.requestRender();
      },
      invalidate() {},
      dispose() { signal.removeEventListener("abort", cancel); },
    };
  });
}

/** Use Pi's editor with a live word counter; submitting only advances to the save preview. */
export async function lessonEditor(ctx: ExtensionContext, title: string, text: string, maxWords: number,
  signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  // Match Editor's whitespace normalization, but retain exact original text on an unchanged submission.
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const safe = visible(normalized);
  if (safe !== normalized) ctx.ui.notify("Invisible characters are escaped for display. Unchanged submissions preserve the original; edited escapes are literal text.", "warning");
  if (ctx.mode !== "tui") {
    // RPC's editor has no AbortSignal support. A cancellable input avoids leaving a command waiting after reload.
    const current = text ? `\nCurrent lesson:\n${safe}\nLeave blank to keep the current lesson.` : "";
    const result = await ctx.ui.input(`${title} — at most ${maxWords} words; submit to review${current}`, "Lesson text", { signal });
    signal.throwIfAborted();
    return result === "" && text ? text : result;
  }
  const result = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const editor = new Editor(tui, {
      borderColor: (s) => theme.fg("border", s),
      selectList: { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: (s) => s },
    });
    editor.setText(safe);
    let finished = false;
    const finish = (value?: string) => { if (!finished) { finished = true; done(value); } };
    const cancel = () => finish();
    editor.onSubmit = finish;
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) queueMicrotask(cancel);
    return {
      get focused() { return editor.focused; },
      set focused(value: boolean) { editor.focused = value; },
      render(width: number) {
        const count = words(editor.getExpandedText());
        return [
          truncateToWidth(theme.fg("accent", title), width), ...editor.render(width),
          truncateToWidth(theme.fg(count > maxWords ? "error" : "dim", `${count}/${maxWords} words · submit to review · ${keys.getKeys("tui.select.cancel").join("/")} cancel`), width),
        ].map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) return finish();
        editor.handleInput(data);
        tui.requestRender();
      },
      invalidate() { editor.invalidate(); },
      dispose() { signal.removeEventListener("abort", cancel); },
    };
  });
  return result === safe ? text : result;
}
