// How often each context section changes between consecutive dialogue prompts of the same NPC: the measured
// basis for SECTIONS_BY_VOLATILITY.

import { textOf, type ChatRequest } from "./messages.ts";
import { chunks } from "./sections.ts";
import { classify, speaker } from "./jobs.ts";

export type SectionStat = { section: string; pairs: number; changed: number; avgTokens: number };

const OWNED = new Set([
  "Physical Activity",
  "Worn Equipment",
  "Physical Appearance",
  "How You Feel",
]);

/** Sections of a dialogue prompt's final message, keyed by a name-neutral title ("<name>'s Inventory"). */
export function contextSections(request: ChatRequest): Map<string, string> {
  const msgs = request.messages ?? [];
  const out = new Map<string, string>();
  let owner = "";

  for (const c of chunks(textOf(msgs[msgs.length - 1]?.content))) {
    if (!c.title) {
      continue;
    }

    if (c.level === 2 && /^.+'s (Current State|Character Profile)/.test(c.title)) {
      owner = c.title.split("'s")[0]!;
    }

    const title = c.title.replace(/^.+?'s /, "<name>'s ");
    let who = "";

    if (OWNED.has(c.title)) {
      who = owner === speaker(request) ? " (NPC)" : " (other)";
    }

    out.set(title + who, c.body);
  }

  return out;
}

/** Change rate per section over consecutive same-NPC dialogue prompts, least volatile first. */
export function volatility(requests: Iterable<ChatRequest>): SectionStat[] {
  const last = new Map<string, Map<string, string>>();
  const stats = new Map<string, { pairs: number; changed: number; tokens: number }>();

  for (const r of requests) {
    if (classify(r).id !== "dialogue") {
      continue;
    }

    const npc = speaker(r);

    if (!npc) {
      continue;
    }

    const now = contextSections(r);
    const prev = last.get(npc);

    if (prev) {
      for (const [k, body] of now) {
        if (!prev.has(k)) {
          continue;
        }

        const s = stats.get(k) ?? { pairs: 0, changed: 0, tokens: 0 };

        s.pairs++;
        s.changed += prev.get(k) === body ? 0 : 1;
        s.tokens += body.length / 4;
        stats.set(k, s);
      }
    }

    last.set(npc, now);
  }

  return [...stats.entries()]
    .map(([section, s]) => ({
      section,
      pairs: s.pairs,
      changed: s.changed,
      avgTokens: Math.round(s.tokens / s.pairs),
    }))
    .sort((a, b) => a.changed / a.pairs - b.changed / b.pairs || b.avgTokens - a.avgTokens);
}
