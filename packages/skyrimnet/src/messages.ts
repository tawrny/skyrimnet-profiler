// OpenAI-style chat request shapes as SkyrimNet sends them, and helpers to replace message text.

import type { ChatRequest as CoreChatRequest, Message } from "@volatility/core";

export { approxTokens, promptText, textOf, type ContentPart, type Message } from "@volatility/core";

/** The fields the shapers set, typed. */
export type ChatRequest = CoreChatRequest & {
  max_tokens?: number;
  stop?: string | string[];
  chat_template_kwargs?: Record<string, unknown>;
};

/** Append text to a message: to the string, or as a new text part when the content is a part list. */
export function appendText(message: Message, addition: string): boolean {
  if (typeof message.content === "string") {
    message.content = message.content.replace(/\n+$/, "") + addition;

    return true;
  }

  if (Array.isArray(message.content)) {
    message.content.push({ type: "text", text: addition });

    return true;
  }

  return false;
}

/** Prepend text to a message: to the string, or as a new first text part when the content is a part list. */
export function prependText(message: Message, addition: string): boolean {
  if (typeof message.content === "string") {
    message.content = addition + message.content;

    return true;
  }

  if (Array.isArray(message.content)) {
    message.content.unshift({ type: "text", text: addition });

    return true;
  }

  return false;
}
