// OpenAI-style chat request shapes as SkyrimNet sends them, and helpers to read and replace message text.

export type ContentPart = { type?: string; text?: string; [key: string]: unknown };
export type Message = { role: string; content: string | ContentPart[] | null; [key: string]: unknown };
export type ChatRequest = {
  messages?: Message[];
  max_tokens?: number;
  stop?: string | string[];
  chat_template_kwargs?: Record<string, unknown>;
  [key: string]: unknown;
};

/** The text of a message's content, joining text parts; images and other parts contribute nothing. */
export function textOf(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part.text === "string" ? part.text : "")).join("");
}

/** Every message's text in order, each prefixed by its role: the prompt as the model reads it. */
export function promptText(request: ChatRequest): string {
  return (request.messages ?? []).map((m) => `[${m.role}]\n${textOf(m.content)}`).join("\n");
}

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

/** Estimated tokens for a length of text (SkyrimNet's prompts average about four characters a token). */
export const approxTokens = (chars: number): number => Math.round(chars / 4);
