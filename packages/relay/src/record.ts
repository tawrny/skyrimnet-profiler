// One call as the relay logs it (a JSON line), how a reply body is read, and how a logged call becomes a CallInput
// for the profiler. The live sink and the log importer both go through toCallInput, so they agree on every field,
// the call's ref included.

import {
  isChatRequest,
  isRecord,
  NO_USAGE,
  usageFromOpenAI,
  type CallInput,
  type ChatRequest,
  type Labels,
  type Usage,
} from "@volatility/core";

export type LogRecord = {
  time: string;
  status: number | null;
  client_gave_up: boolean;
  asked_max_tokens: number | null;
  seconds: number;
  first_byte_ms: number | null;
  /** llama-server's split of the call: tokens reused from cache, read and generated. */
  timings: unknown;
  /** Which upstream provider served the call (OpenRouter); its cache is the one that counts. */
  provider: string | null;
  usage: unknown;
  shaping: unknown;
  /** The request as forwarded, or the start of the body when it wasn't JSON. */
  request: ChatRequest | { raw: string };
  reply: string;
  reasoning: string;
};

type ReplyParts = {
  reply: string;
  reasoning: string;
  timings: unknown;
  usage: unknown;
  provider: string | null;
};

const str = (x: unknown): string => (typeof x === "string" ? x : "");

function choiceTexts(
  choices: unknown,
  key: "delta" | "message",
): { content: string; reasoning: string }[] {
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.map((choice: unknown) => {
    const part = isRecord(choice) && isRecord(choice[key]) ? choice[key] : {};

    return { content: str(part.content), reasoning: str(part.reasoning_content) };
  });
}

/** The assistant text, reasoning, llama-server timings, and usage and provider, from a JSON or SSE reply body. */
export function replyText(body: string, streamed: boolean): ReplyParts {
  const out: ReplyParts = { reply: "", reasoning: "", timings: null, usage: null, provider: null };

  const take = (chunk: unknown, key: "delta" | "message") => {
    if (!isRecord(chunk)) {
      return;
    }

    out.timings = chunk.timings ?? out.timings;
    out.usage = chunk.usage ?? out.usage;
    out.provider = typeof chunk.provider === "string" ? chunk.provider : out.provider;

    for (const { content, reasoning } of choiceTexts(chunk.choices, key)) {
      out.reply += content;
      out.reasoning += reasoning;
    }
  };

  try {
    if (!streamed) {
      take(JSON.parse(body), "message");

      return out;
    }

    for (const raw of body.split("\n")) {
      const line = raw.trim();

      if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
        take(JSON.parse(line.slice(5).trim()), "delta");
      }
    }

    return out;
  } catch {
    return { ...out, reply: body.slice(0, 2000), reasoning: "" };
  }
}

const numberOrNull = (x: unknown): number | null => (typeof x === "number" ? x : null);

/** Usage as the provider reported it; failing that, from llama-server's timings. */
function usageOf(record: Record<string, unknown>): Usage {
  if (isRecord(record.usage)) {
    return usageFromOpenAI(record.usage);
  }

  if (!isRecord(record.timings)) {
    return NO_USAGE;
  }

  const cached = numberOrNull(record.timings.cache_n);
  const read = numberOrNull(record.timings.prompt_n);

  return {
    inputTokens: read === null ? null : read + (cached ?? 0),
    cachedInputTokens: cached,
    outputTokens: numberOrNull(record.timings.predicted_n),
    costUsd: null,
  };
}

/** A logged chat call as the profiler's input; null for a line that isn't one (a non-JSON body, say). */
export function toCallInput(
  line: unknown,
  label?: (request: ChatRequest) => Labels,
): CallInput | null {
  if (!isRecord(line) || typeof line.time !== "string" || !isChatRequest(line.request)) {
    return null;
  }

  if (line.request.messages === undefined) {
    return null;
  }

  const seconds = numberOrNull(line.seconds);
  const labels = label?.(line.request);

  return {
    // Logged in local time without a zone; read the same way by every ingest path.
    time: new Date(line.time).toISOString(),
    request: line.request,
    reply: str(line.reply),
    reasoning: str(line.reasoning),
    status: numberOrNull(line.status),
    durationMs: seconds === null ? null : Math.round(seconds * 1000),
    firstTokenMs: numberOrNull(line.first_byte_ms),
    provider: typeof line.provider === "string" ? line.provider : null,
    usage: usageOf(line),
    ...(labels ? { labels } : {}),
    meta: {
      shaping: line.shaping ?? null,
      clientGaveUp: line.client_gave_up === true,
      askedMaxTokens: numberOrNull(line.asked_max_tokens),
      timings: line.timings ?? null,
    },
  };
}
