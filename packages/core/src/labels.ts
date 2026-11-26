// What a source says about a call: its kind (the job it does) and its actor (who it's for), plus the names to
// strip so the same piece of prompt for two actors compares as equal.

import { textOf, type ChatRequest } from "./chat.ts";

export type Labels = {
  kind: string;
  actor: string | null;
  actorNames: readonly string[];
};

/** A source adapter: labels for one request. */
export type Source = (request: ChatRequest) => Labels;

const KIND_LENGTH = 60;

/** Without an adapter: the kind is the opening line of the first message, and there is no actor. */
export const defaultSource: Source = (request) => ({
  kind: openingLine(request),
  actor: null,
  actorNames: [],
});

function openingLine(request: ChatRequest): string {
  const firstLine = textOf(request.messages?.[0]?.content).trim().split("\n")[0] ?? "";

  return firstLine.slice(0, KIND_LENGTH) || "(empty)";
}
