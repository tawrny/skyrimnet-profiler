// The context block at the end of SkyrimNet's dialogue prompt, split into its markdown sections and reordered
// by how often each changes between one turn and the next.
//
// A model server reuses only an unchanged prefix of a prompt. The dialogue prompt is: system message (the NPC's
// bio and rules), then the conversation history (which grows at its end every turn), then a ~11k-token context
// block. Anything after the newest history line is re-read every turn, so the stable part of the context block
// is moved into the system message, ahead of the history; only the volatile sections stay after it.

import { appendText, type ChatRequest } from "./messages.ts";

export type Chunk = { heading: string | null; level: number; title: string | null; body: string };

/** Sections that change turn to turn, least volatile first. Matched on the heading text without the #s. */
export const SECTIONS_BY_VOLATILITY: readonly string[] = [
  "Worn Equipment",
  "Physical Activity",
  "How You Feel",
  "Current Weather",
  "Current Time",
  "Nearby People",
  "Recent Events",
];
/** Headings ending with these are volatile too (they change with the conversation's topic). */
export const VOLATILE_SUFFIXES: readonly string[] = ["Potentially Relevant Memories"];
const MEMORIES = "~memories"; // their slot in the moved order: the least volatile of the moved
export const ANCHOR = "Task"; // the volatile sections go just before this heading

const HEADING = /^(#{2,3}) (.+)$/gm;
const OWNER = /^(?<name>.+?)'s (?:Current State|Character Profile)\b.*?(?<you>THIS IS YOU\))?\s*$/;

/** Split text into chunks at every ## and ### heading; text before the first heading is a chunk of its own. */
export function chunks(text: string): Chunk[] {
  const marks = [...text.matchAll(HEADING)];
  if (marks.length === 0) {
    return [{ heading: null, level: 0, title: null, body: text }];
  }
  const out: Chunk[] = [];
  const first = marks[0]!;
  if (first.index > 0) {
    out.push({ heading: null, level: 0, title: null, body: text.slice(0, first.index) });
  }
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : text.length;
    out.push({
      heading: m[0],
      level: m[1]!.length,
      title: m[2]!.trim(),
      body: text.slice(m.index + m[0].length, end),
    });
  });
  return out;
}

const isVolatile = (title: string): boolean =>
  SECTIONS_BY_VOLATILITY.includes(title) || VOLATILE_SUFFIXES.some((s) => title.endsWith(s));

/**
 * Split a dialogue context block into [stable, rest]: stable = the sections that don't change turn to turn, in
 * their original order; rest = the volatile sections (least volatile first, each labelled with its owner, e.g.
 * "## Physical Activity (Vigilance, you)"), then the task and everything after it unchanged.
 * Returns null when the block has no task heading.
 */
export function split(text: string): [string, string] | null {
  const all = chunks(text);
  const at = all.findIndex((c) => c.title === ANCHOR);
  if (at < 0) {
    return null;
  }
  let owner: string | null = null;
  const stable: string[] = [];
  const moved = new Map<string, string[]>();
  for (const c of all.slice(0, at)) {
    if (c.title) {
      const m = OWNER.exec(c.title);
      if (m && c.level === 2) {
        owner = m.groups!.name! + (m.groups!.you ? ", you" : "");
      }
    }
    if (c.title && isVolatile(c.title)) {
      const listed = SECTIONS_BY_VOLATILITY.includes(c.title);
      const label = `${"#".repeat(c.level)} ${c.title}` + (owner && listed ? ` (${owner})` : "");
      const key = listed ? c.title : MEMORIES;
      moved.set(key, [...(moved.get(key) ?? []), label + c.body]);
    } else {
      stable.push((c.heading ?? "") + c.body);
    }
  }
  const order = [MEMORIES, ...SECTIONS_BY_VOLATILITY];
  const rest =
    order.flatMap((k) => moved.get(k) ?? []).join("") +
    all
      .slice(at)
      .map((c) => (c.heading ?? "") + c.body)
      .join("");
  return [stable.join(""), rest];
}

/**
 * Move the stable part of a dialogue request's final context block to the end of its system message, so it sits
 * before the conversation history and stays a reusable prefix. Mutates the request; true when it changed.
 */
export function moveStableToSystem(request: ChatRequest): boolean {
  const msgs = request.messages ?? [];
  const system = msgs[0];
  const last = msgs[msgs.length - 1];
  if (
    msgs.length < 2 ||
    !system ||
    !last ||
    system.role !== "system" ||
    typeof last.content !== "string"
  ) {
    return false;
  }
  const parts = split(last.content);
  if (!parts || !parts[0].trim()) {
    return false;
  }
  const [stable, rest] = parts;
  if (!appendText(system, "\n\n" + stable.replace(/^\n+|\n+$/g, "") + "\n")) {
    return false;
  }
  last.content = rest;
  return true;
}
