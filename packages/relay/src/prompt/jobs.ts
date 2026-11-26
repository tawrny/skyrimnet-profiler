// Which SkyrimNet job a request is, from the opening of its first message.

import { afterSharedCatalogue } from "./actions.ts";
import { textOf, type ChatRequest } from "./messages.ts";

export type Job = {
  id: string;
  label: string;
  /** Answered without thinking: small structured answers where thinking cost ~2 s a call for no gain. */
  noThink: boolean;
  match: (first: string) => boolean;
};

const starts = (prefix: string) => (first: string) => first.startsWith(prefix);

// Tested 2026-11-24 on 8 captured calls each, thinking off: answer shape 8/8 for every noThink job; mood 7/8 and
// action choice 8/8 the same as with thinking. The pickers stay thinking: without it they reversed direction
// ("player>Belethor") or picked someone else. Dialogue plans in its reply without thinking.
export const JOBS: readonly Job[] = [
  { id: "mood", label: "Mood", noThink: true, match: starts("You are an AI mood analyzer") },
  { id: "action", label: "Action selection", noThink: true, match: starts("You select the single most appropriate action") },
  { id: "search", label: "Memory search query", noThink: true, match: starts("You are a memory search query generator") },
  { id: "banter", label: "Banter director", noThink: true, match: starts("You are an ambient banter director") },
  { id: "social", label: "Social Life DM", noThink: true, match: starts("# NPC Social Life") },
  { id: "picker", label: "Target picker", noThink: false, match: starts("Determine which NPC the player") },
  { id: "speaker", label: "Speaker selector", noThink: false, match: starts("## Task") },
  { id: "memory", label: "Memory writing", noThink: false, match: starts("You are an AI assistant that helps create memories") },
  { id: "vision", label: "OmniSight", noThink: false, match: (f) => f.startsWith("You are describing what is currently visible") || f.startsWith("Write the description of the place in this image") },
  { id: "stance", label: "Stance assessment", noThink: false, match: starts("You are an internal stance-assessment") },
  { id: "dialogue", label: "Dialogue", noThink: false, match: (f) => /^You are .+?, an? .+ in Skyrim\./.test(f) },
];
const OTHER: Job = { id: "other", label: "Other", noThink: false, match: () => true };

/** The first message's text, after a shared action catalogue the relay placed ahead of it. */
export function firstText(request: ChatRequest): string {
  return afterSharedCatalogue(textOf(request.messages?.[0]?.content).trimStart());
}

export function classify(request: ChatRequest): Job {
  const first = firstText(request);
  return JOBS.find((j) => j.match(first)) ?? OTHER;
}

/** The speaking NPC of a dialogue-style request ("You are Vigilance, a Male Dog in Skyrim."), else null. */
export function speaker(request: ChatRequest): string | null {
  return /^You are (.+?), an? /.exec(firstText(request))?.[1] ?? null;
}
