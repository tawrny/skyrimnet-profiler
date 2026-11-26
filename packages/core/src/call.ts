// A call as a source hands it over (CallInput), and as the store keeps it (RecordedCall): labelled, split into
// segments, with the request's parameters kept apart from its messages.

import { createHash } from "node:crypto";
import { isChatRequest, isRecord, promptText, type ChatRequest } from "./chat.ts";
import { defaultSource, type Labels, type Source } from "./labels.ts";
import { segmentRequest, type Segment } from "./segments.ts";

/** Named after OpenTelemetry's gen_ai.usage.* attributes; null where the provider didn't say. */
export type Usage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

export type CallInput = {
  /** ISO 8601. */
  time: string;
  request: ChatRequest;
  reply: string;
  reasoning: string;
  status: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  provider: string | null;
  usage: Usage;
  /** Labels the source already worked out; without them the store's default source labels the call. */
  labels?: Labels;
  /** Anything source-specific worth keeping, such as how the relay shaped the request. */
  meta?: Record<string, unknown>;
};

export type RecordedCall = {
  /** Identifies the call across ingest paths, so a live call and a later import of the same log don't double. */
  ref: string;
  time: string;
  kind: string;
  actor: string | null;
  model: string | null;
  provider: string | null;
  status: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  usage: Usage;
  /** The request without its messages: model, temperature, max tokens and so on. */
  params: Record<string, unknown>;
  segments: Segment[];
  reply: string;
  reasoning: string;
  meta: Record<string, unknown>;
};

export const NO_USAGE: Usage = {
  inputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  costUsd: null,
};

export function toRecordedCall(input: CallInput, source: Source = defaultSource): RecordedCall {
  const labels = input.labels ?? source(input.request);
  const { messages: _messages, ...params } = input.request;

  return {
    ref: callRef(input.time, input.request),
    time: input.time,
    kind: labels.kind,
    actor: labels.actor,
    model: typeof input.request.model === "string" ? input.request.model : null,
    provider: input.provider,
    status: input.status,
    durationMs: input.durationMs,
    firstTokenMs: input.firstTokenMs,
    usage: input.usage,
    params,
    segments: segmentRequest(input.request, labels.actorNames),
    reply: input.reply,
    reasoning: input.reasoning,
    meta: input.meta ?? {},
  };
}

export function callRef(time: string, request: ChatRequest): string {
  return createHash("sha256")
    .update(`${time}\n${promptText(request)}`)
    .digest("hex");
}

const numberOrNull = (x: unknown): number | null => (typeof x === "number" ? x : null);

/** Usage from an OpenAI-style reply's usage object (OpenRouter adds cost). */
export function usageFromOpenAI(raw: unknown): Usage {
  if (!isRecord(raw)) {
    return NO_USAGE;
  }

  const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};

  return {
    inputTokens: numberOrNull(raw.prompt_tokens),
    cachedInputTokens: numberOrNull(details.cached_tokens),
    outputTokens: numberOrNull(raw.completion_tokens),
    costUsd: numberOrNull(raw.cost),
  };
}

function isUsage(x: unknown): x is Usage {
  if (!isRecord(x)) {
    return false;
  }

  return [x.inputTokens, x.cachedInputTokens, x.outputTokens, x.costUsd].every(
    (v) => v === null || typeof v === "number",
  );
}

function isLabels(x: unknown): x is Labels {
  if (!isRecord(x)) {
    return false;
  }

  if (typeof x.kind !== "string") {
    return false;
  }

  if (x.actor !== null && typeof x.actor !== "string") {
    return false;
  }

  return Array.isArray(x.actorNames) && x.actorNames.every((n) => typeof n === "string");
}

const isNullableNumber = (x: unknown) => x === null || typeof x === "number";

/** A CallInput as JSON from an ingest endpoint or file. */
export function isCallInput(x: unknown): x is CallInput {
  if (!isRecord(x)) {
    return false;
  }

  if (typeof x.time !== "string" || !isChatRequest(x.request)) {
    return false;
  }

  if (typeof x.reply !== "string" || typeof x.reasoning !== "string") {
    return false;
  }

  if (![x.status, x.durationMs, x.firstTokenMs].every(isNullableNumber)) {
    return false;
  }

  if (x.provider !== null && typeof x.provider !== "string") {
    return false;
  }

  if (!isUsage(x.usage)) {
    return false;
  }

  if (x.labels !== undefined && !isLabels(x.labels)) {
    return false;
  }

  return x.meta === undefined || isRecord(x.meta);
}
