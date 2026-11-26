import type { SectionStat, Span } from "@skyrimnet/relay/prompt";

export type CallSummary = {
  index: number;
  time: string;
  seconds: number;
  status?: number;
  job: string;
  jobLabel: string;
  npc: string | null;
  promptTokens: number;
  thinking: boolean;
  gaveUp: boolean;
  reply: string;
};

export type CallDetail = CallSummary & {
  request: { messages?: { role: string; content: unknown }[] };
  replyFull: string;
  reasoning: string;
  shaping: unknown;
  anatomy: Span[];
  promptChars: number;
  previousIndex: number | null;
  sharedChars: number;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`${path}: ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  calls: (limit = 500) => get<{ total: number; calls: CallSummary[] }>(`/api/calls?limit=${limit}`),
  call: (index: number) => get<CallDetail>(`/api/calls/${index}`),
  volatility: (last = 2000) => get<SectionStat[]>(`/api/volatility?last=${last}`),
};
