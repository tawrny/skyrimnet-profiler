// How much of a prompt a provider's prefix cache could serve, and where the reusable prefix ends.
//
// A provider reuses the longest start of a prompt it has already seen, from any earlier call while that call is
// still cached, not just the same NPC's last turn. So a call is compared with every earlier call in a window,
// and the section holding its first changed character is named: that section, and everything after it, is
// re-read at full price.

import { anatomy, sharedPrefix } from "./anatomy.ts";
import { classify, speaker } from "./jobs.ts";
import { promptText, type ChatRequest } from "./messages.ts";

/** An earlier call, as the cache would have seen it. */
export type Seen = { text: string; npc: string | null; job: string };

/** Which earlier call supplied the longest shared prefix. */
export type MatchKind = "same NPC" | "same job" | "other job";

export type Reach = {
  promptChars: number;
  sharedChars: number;
  match: MatchKind | null;
  /** The section where the first difference is, "<kind>: <label>", or "whole prompt" when nothing differs. */
  breaksIn: string;
};

export function seen(request: ChatRequest): Seen {
  return { text: promptText(request), npc: speaker(request), job: classify(request).id };
}

/** The longest prefix this request shares with any earlier call, which call that was, and where it ends. */
export function reach(request: ChatRequest, earlier: readonly Seen[]): Reach {
  const me = seen(request);
  let sharedChars = 0;
  let match: MatchKind | null = null;

  for (const e of earlier) {
    const n = sharedPrefix(me.text, e.text);

    if (n <= sharedChars) {
      continue;
    }

    sharedChars = n;
    match = matchKind(me, e);
  }

  return {
    promptChars: me.text.length,
    sharedChars,
    match,
    breaksIn: breakLabel(request, sharedChars, me.text.length),
  };
}

function breakLabel(request: ChatRequest, at: number, length: number): string {
  if (at >= length) {
    return "whole prompt";
  }

  const span = anatomy(request).find((s) => at >= s.start && at < s.start + s.length);

  return span ? `${span.kind}: ${span.label}` : "unknown";
}

function matchKind(me: Seen, earlier: Seen): MatchKind {
  if (earlier.job !== me.job) {
    return "other job";
  }

  return me.npc !== null && earlier.npc === me.npc ? "same NPC" : "same job";
}
