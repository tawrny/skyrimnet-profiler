// A prompt broken into labelled spans, for the viewer: where each part sits, how big it is, and how much of a
// prompt is an unchanged prefix of the previous one (what a model server can reuse instead of re-reading).

import { CATALOGUE_HEADING } from "./actions.ts";
import { textOf, type ChatRequest } from "./messages.ts";
import { ANCHOR, chunks, SECTIONS_BY_VOLATILITY, VOLATILE_SUFFIXES } from "./sections.ts";

export type SpanKind =
  | "system"
  | "catalogue"
  | "history"
  | "stable"
  | "volatile"
  | "task"
  | "actions"
  | "other";
export type Span = { kind: SpanKind; label: string; start: number; length: number };

const volatileTitle = (title: string) => {
  const t = title.replace(/ \([^)]*\)$/, ""); // a moved section carries its owner: "Physical Activity (Lydia, you)"
  return SECTIONS_BY_VOLATILITY.includes(t) || VOLATILE_SUFFIXES.some((s) => t.endsWith(s));
};

/** Spans over promptText(request) (each message as "[role]\n" + text, joined by "\n"). */
export function anatomy(request: ChatRequest): Span[] {
  const msgs = request.messages ?? [];
  const spans: Span[] = [];
  let pos = 0;
  const push = (kind: SpanKind, label: string, length: number) => {
    const prev = spans[spans.length - 1];
    if (prev && prev.kind === kind && kind === "history") prev.length += length;
    else spans.push({ kind, label, start: pos, length });
    pos += length;
  };
  msgs.forEach((m, i) => {
    const text = textOf(m.content);
    const header = `[${m.role}]\n`.length + (i > 0 ? 1 : 0);
    const isFirst = i === 0;
    const isLast = i === msgs.length - 1 && msgs.length > 1;
    if (!isFirst && !isLast) {
      push("history", "History", header + text.length);
      return;
    }
    let first = true;
    let afterTask = false;
    let inCatalogue = false;
    for (const c of chunks(text)) {
      const length = (first ? header : 0) + (c.heading?.length ?? 0) + c.body.length;
      first = false;
      const title = c.title ?? (isFirst ? "Bio and rules" : "Setting");
      let kind: SpanKind;
      if (isFirst) {
        if (c.heading) inCatalogue = c.heading === CATALOGUE_HEADING; // the catalogue has no sub-headings
        kind = inCatalogue ? "catalogue" : "system";
      } else {
        if (c.title === ANCHOR) afterTask = true;
        if (c.title && /Actions Available|^Other$/.test(c.title)) kind = "actions";
        else if (afterTask) kind = "task";
        else kind = c.title && volatileTitle(c.title) ? "volatile" : "stable";
      }
      push(kind, title, length);
    }
  });
  return spans;
}

/** Length of the common prefix of two strings. */
export function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}
