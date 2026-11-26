// A prompt split into segments: the pieces whose change rates the profiler measures.
//
// The first message is the opening, the last is the latest, and everything between is the history. The opening
// and the latest split further at markdown headings; the history stays one segment, since it grows by appending.
// Each segment is hashed twice: as written, and with the actor's names replaced, so a piece that differs only by
// whose prompt it is can be told apart from one that really differs.

import { createHash } from "node:crypto";
import { approxTokens, textOf, type ChatRequest, type Message } from "./chat.ts";

export type Place = "opening" | "history" | "latest";

export type Segment = {
  /** Order in the prompt, from 0. */
  position: number;
  /** Index of the message it came from (the first history message, for the history). */
  message: number;
  role: string;
  /** "<place> › <heading>", with actor names replaced, numbered when a heading repeats: comparable across calls. */
  name: string;
  text: string;
  hash: string;
  /** Hash of the text with the actor's names replaced by {actor}. */
  templateHash: string;
  tokens: number;
};

export const ACTOR_PLACEHOLDER = "{actor}";
export const UNHEADED = "(text)";

const HEADING = /^#{1,6} .+$/gm;

type Piece = { title: string; text: string };

/** Split text at markdown headings; any text before the first heading is a piece of its own. */
export function pieces(text: string): Piece[] {
  const marks = [...text.matchAll(HEADING)];
  const firstHeadingAt = marks[0]?.index ?? text.length;
  const out: Piece[] = [];

  if (firstHeadingAt > 0 || marks.length === 0) {
    out.push({ title: UNHEADED, text: text.slice(0, firstHeadingAt) });
  }

  marks.forEach((mark, i) => {
    const end = marks[i + 1]?.index ?? text.length;

    out.push({ title: mark[0].replace(/^#+ /, "").trim(), text: text.slice(mark.index, end) });
  });

  return out;
}

/** Replace each actor name with the placeholder, longest name first so "Lydia Gray" wins over "Lydia". */
export function deName(text: string, actorNames: readonly string[]): string {
  const names = actorNames.filter((n) => n.length >= 2).sort((a, b) => b.length - a.length);

  return names.reduce((out, name) => out.split(name).join(ACTOR_PLACEHOLDER), text);
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export function segmentRequest(request: ChatRequest, actorNames: readonly string[]): Segment[] {
  const messages = request.messages ?? [];
  const segments: Segment[] = [];
  const seenNames = new Map<string, number>();

  const add = (message: number, role: string, place: Place, title: string, text: string) => {
    const base = `${place} › ${deName(title, actorNames)}`;
    const count = (seenNames.get(base) ?? 0) + 1;

    seenNames.set(base, count);
    segments.push({
      position: segments.length,
      message,
      role,
      name: count === 1 ? base : `${base} (${count})`,
      text,
      hash: sha256(text),
      templateHash: sha256(deName(text, actorNames)),
      tokens: approxTokens(text.length),
    });
  };

  const addSplit = (message: number, m: Message, place: Place) => {
    for (const piece of pieces(textOf(m.content))) {
      add(message, m.role, place, piece.title, piece.text);
    }
  };

  const [opening] = messages;

  if (opening) {
    addSplit(0, opening, "opening");
  }

  const history = messages.slice(1, -1);

  if (history.length > 0) {
    const text = history.map((m) => `[${m.role}]\n${textOf(m.content)}`).join("\n");

    add(1, "history", "history", "messages", text);
  }

  const latest = messages.at(-1);

  if (latest && messages.length > 1) {
    addSplit(messages.length - 1, latest, "latest");
  }

  return segments;
}
