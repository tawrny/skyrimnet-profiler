// The relay's request shaping, in order: generation cap and stop sequences, thinking per job, then (each
// switchable) the action trim, the action catalogue, and moving stable context ahead of the history.

import {
  applyCatalogue,
  trimRequest,
  type CatalogueScope,
  type CatalogueStore,
} from "./actions.ts";
import { classify, speaker } from "./jobs.ts";
import type { ChatRequest } from "./messages.ts";
import { moveStableToSystem } from "./sections.ts";

export type ShapeOptions = {
  /** Cap on any request's max_tokens (0 = none). The model sometimes ends on a token the server does not treat
   * as end-of-generation and ran on to SkyrimNet's 4096. */
  maxTokens: number;
  extraStop: readonly string[];
  noThink: boolean;
  trim: boolean;
  catalogue: CatalogueMode;
  reorder: boolean;
};

export type CatalogueMode = "off" | CatalogueScope;
export const CATALOGUE_MODES: readonly CatalogueMode[] = ["off", "npc", "shared"];
export function isCatalogueMode(x: unknown): x is CatalogueMode {
  return CATALOGUE_MODES.some((m) => m === x);
}

export const DEFAULTS: ShapeOptions = {
  maxTokens: 1024,
  extraStop: ["</s>", "<|tool_response>"],
  noThink: true,
  trim: false,
  catalogue: "off",
  reorder: false,
};

export type ShapeReport = {
  job: string;
  askedMaxTokens: number | null;
  noThink: boolean;
  trimmedChars: number;
  catalogue: { added: string[]; changed: string[] } | null;
  reordered: boolean;
};

/** Shape a request in place; store is the per-NPC action catalogue (mutated when the catalogue is on). */
export function shape(
  request: ChatRequest,
  opts: ShapeOptions,
  store: CatalogueStore,
): ShapeReport {
  const job = classify(request);
  const asked = typeof request.max_tokens === "number" ? request.max_tokens : null;
  if (opts.maxTokens) request.max_tokens = Math.min(asked ?? opts.maxTokens, opts.maxTokens);
  const stop =
    request.stop == null
      ? []
      : typeof request.stop === "string"
        ? [request.stop]
        : [...request.stop];
  request.stop = [...stop, ...opts.extraStop.filter((s) => !stop.includes(s))];
  const noThink = opts.noThink && job.noThink;
  if (noThink)
    request.chat_template_kwargs = { ...request.chat_template_kwargs, enable_thinking: false };

  const report: ShapeReport = {
    job: job.id,
    askedMaxTokens: asked,
    noThink,
    trimmedChars: 0,
    catalogue: null,
    reordered: false,
  };
  if (job.id !== "dialogue") return report;
  const npc = speaker(request);
  if (opts.trim && opts.catalogue === "off") report.trimmedChars = trimRequest(request);
  if (opts.catalogue !== "off" && npc) {
    const r = applyCatalogue(request, npc, store, opts.catalogue, opts.trim);
    if (r.applied) report.catalogue = { added: r.added, changed: r.changed };
  }
  if (opts.reorder) report.reordered = moveStableToSystem(request);
  return report;
}
