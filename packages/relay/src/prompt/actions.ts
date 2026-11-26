// SkyrimNet's action list: the "**Available Actions:**" block of a dialogue prompt, ~40% of it.
//
// Two shapers:
//  - trim: list the nearby actors once instead of in every actor parameter, and keep each description's first
//    sentence;
//  - catalogue: the list changes most turns only in WHICH actions are eligible and WHO fills the target lists;
//    the descriptions themselves never change. So every action ever seen for an NPC goes into a stable catalogue
//    in the system message (cached), and the end of the prompt says only which are available now.

import { appendText, type ChatRequest } from "./messages.ts";

export const BLOCK_START = "**Available Actions:**";
export const BLOCK_END = "**Guidelines:**";
export const SEP = " — "; // " — " between an action's parameters and its description
const MAX_DESC = 220;
const KEEP_WHOLE = new Set(["TriggerDialogueLine"]);
const CHOICES = /Valid Choices: ((?:'[^']*'(?:, )?)+)\. Choose one of these actor names EXACTLY\./g;
const CHOICES_POINTER = "Must be a name from the Nearby actors line above, exactly.";
const ENTRY = /^- `([^`]+)`/;

export type Entry = { name: string; lines: string[] };
export type Block = { start: number; end: number; items: (Entry | string)[]; names: string[] };

/** Locate and parse the action block of a text; null when it has none. Actor-choice lists are replaced by a
 * pointer to one Nearby actors line, and the names they listed are collected (first-seen order). */
export function parseBlock(text: string): Block | null {
  const start = text.indexOf(BLOCK_START);
  if (start < 0) return null;
  const found = text.indexOf(BLOCK_END, start);
  const end = found > 0 ? found : text.length;
  let block = text.slice(start, end);
  const names: string[] = [];
  for (const m of block.matchAll(CHOICES)) {
    for (const n of m[1]!.matchAll(/'([^']*)'/g)) if (!names.includes(n[1]!)) names.push(n[1]!);
  }
  block = block.replace(CHOICES, CHOICES_POINTER);
  // An entry starts at "- `Name`" and runs until the next entry or a blank line; some span many lines.
  const items: (Entry | string)[] = [];
  let cur: Entry | null = null;
  for (const line of block.split("\n")) {
    const m = ENTRY.exec(line);
    if (m) {
      if (cur) items.push(cur);
      cur = { name: m[1]!, lines: [line] };
    } else if (cur && line.trim()) {
      cur.lines.push(line);
    } else {
      if (cur) items.push(cur);
      cur = null;
      items.push(line);
    }
  }
  if (cur) items.push(cur);
  return { start, end, items, names };
}

function firstSentence(desc: string): string {
  const d = desc.trim();
  const m = /(?<=[.!?])\s/.exec(d);
  let first = m ? d.slice(0, m.index) : d;
  if (first.length > MAX_DESC) first = first.slice(0, MAX_DESC).replace(/ [^ ]*$/, "") + "…";
  return first;
}

/** The entry with its description cut to the first sentence; whole when it has no " — " or must stay whole. */
export function shortEntry(e: Entry): string[] {
  if (KEEP_WHOLE.has(e.name) || !e.lines[0]!.includes(SEP)) return e.lines;
  const whole = e.lines.map((s) => s.trim()).join(" ");
  const cut = (text: string, last: boolean): [string, string] => {
    const i = last ? text.lastIndexOf(SEP) : text.indexOf(SEP);
    return [text.slice(0, i), text.slice(i + SEP.length)];
  };
  let [head, desc] = cut(whole, whole.split(SEP).length - 1 !== 1);
  if (head.includes('"}') || !head.endsWith("}")) [head, desc] = cut(whole, false);
  return [head + SEP + firstSentence(desc)];
}

const nearbyLine = (names: string[]): string => `Nearby actors: ${names.join(", ")}.`;

/** Rewrite a text's action block: actor lists once, descriptions to their first sentence. */
export function trim(text: string): string {
  const b = parseBlock(text);
  if (!b) return text;
  const out = b.items.flatMap((it) => (typeof it === "string" ? [it] : shortEntry(it)));
  let block = out.join("\n");
  if (b.names.length) block = block.replace(BLOCK_START, `${BLOCK_START}\n${nearbyLine(b.names)}`);
  return text.slice(0, b.start) + block + text.slice(b.end);
}

/** Apply trim() to every message of a request; returns characters saved. */
export function trimRequest(request: ChatRequest): number {
  let saved = 0;
  for (const m of request.messages ?? []) {
    if (typeof m.content === "string") {
      const t = trim(m.content);
      saved += m.content.length - t.length;
      m.content = t;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p.text !== "string") continue;
        const t = trim(p.text);
        saved += p.text.length - t.length;
        p.text = t;
      }
    }
  }
  return saved;
}

/** Per-NPC store of every action entry seen, by action name. Kept by the relay across turns and restarts. */
export type CatalogueStore = Record<string, Record<string, string>>;

export const CATALOGUE_HEADING = "## Action Catalogue";
/** Entries whose text is live state, kept whole at the end instead of in the catalogue: TriggerDialogueLine
 * carries the quest exchanges the NPC can trigger right now (it was the only entry whose text changed between
 * turns, 26 times in a 104-turn replay). */
export const CATALOGUE_EXCLUDE = new Set(["TriggerDialogueLine"]);
const CATALOGUE_INTRO =
  "Every action you may be able to take, with its format. Only the actions listed as available now, at the end " +
  "of this prompt, can be used right now; the others are here for reference.";

/** The catalogue section for one NPC: entries sorted by name, so it changes only when a new action appears. */
export function catalogueText(entries: Record<string, string>): string {
  const lines = Object.keys(entries)
    .sort((a, b) => a.localeCompare(b))
    .map((k) => entries[k]!);
  return `\n\n${CATALOGUE_HEADING}\n${CATALOGUE_INTRO}\n${lines.join("\n")}\n`;
}

export type CatalogueResult = { applied: boolean; added: string[]; changed: string[] };

/**
 * Move a dialogue request's action entries into the per-NPC catalogue (appended to the system message) and
 * leave in their place one line naming the actions available now plus the nearby actors. Entries are kept as
 * whole or shortened (shorten=true) text. Mutates the request and the store.
 */
export function applyCatalogue(
  request: ChatRequest,
  npc: string,
  store: CatalogueStore,
  shorten = false,
): CatalogueResult {
  const none: CatalogueResult = { applied: false, added: [], changed: [] };
  const msgs = request.messages ?? [];
  const system = msgs[0];
  const last = msgs[msgs.length - 1];
  if (!system || !last || system.role !== "system" || typeof last.content !== "string") return none;
  const b = parseBlock(last.content);
  if (!b) return none;
  const entries = b.items.filter((it): it is Entry => typeof it !== "string");
  if (entries.length === 0) return none;
  const book = (store[npc] ??= {});
  const added: string[] = [];
  const changed: string[] = [];
  const live: string[] = [];
  for (const e of entries) {
    if (CATALOGUE_EXCLUDE.has(e.name)) {
      live.push(...e.lines);
      continue;
    }
    const text = (shorten ? shortEntry(e) : e.lines).join("\n");
    if (!(e.name in book)) added.push(e.name);
    else if (book[e.name] !== text) changed.push(e.name);
    book[e.name] = text;
  }
  const others = b.items.filter((it): it is string => typeof it === "string" && it.trim() !== "");
  const available = `Available now: ${entries.map((e) => "`" + e.name + "`").join(", ")}. Formats and descriptions are in the Action Catalogue above.`;
  const replacement = [
    others[0] ?? BLOCK_START,
    available,
    ...(b.names.length ? [nearbyLine(b.names)] : []),
    ...live,
    ...others.slice(1),
  ];
  last.content = last.content.slice(0, b.start) + replacement.join("\n") + "\n\n" + last.content.slice(b.end);
  appendText(system, catalogueText(book));
  return { applied: true, added, changed };
}
