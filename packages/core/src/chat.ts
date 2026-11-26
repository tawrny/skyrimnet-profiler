// OpenAI-compatible chat request shapes, the format every source's calls arrive in.

export type ContentPart = { type?: string; text?: string; [key: string]: unknown };

export type Message = {
  role: string;
  content: string | ContentPart[] | null;
  [key: string]: unknown;
};

export type ChatRequest = {
  messages?: Message[];
  model?: string;
  [key: string]: unknown;
};

/** The text of a message's content, joining text parts; images and other parts contribute nothing. */
export function textOf(content: Message["content"] | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
}

/** Every message's text in order, each prefixed by its role: the prompt as the model reads it. */
export function promptText(request: ChatRequest): string {
  return (request.messages ?? []).map((m) => `[${m.role}]\n${textOf(m.content)}`).join("\n");
}

/** Estimated tokens for a length of text (about four characters a token for English prose). */
export const approxTokens = (chars: number): number => Math.round(chars / 4);

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isMessage(x: unknown): x is Message {
  return isRecord(x) && typeof x.role === "string";
}

export function isChatRequest(x: unknown): x is ChatRequest {
  if (!isRecord(x)) {
    return false;
  }

  if (x.messages === undefined) {
    return true;
  }

  return Array.isArray(x.messages) && x.messages.every(isMessage);
}
