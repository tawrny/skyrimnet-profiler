// The CallStore port: what the profiler needs from storage. SQLite implements it now (@volatility/store-sqlite);
// Postgres can later, behind the same interface.

import type { RecordedCall, Usage } from "./call.ts";
import type { Segment } from "./segments.ts";
import type { CallRow } from "./volatility.ts";

export type CallFilter = { kind?: string; actor?: string };

export const CALL_SORTS = ["time", "duration", "promptTokens", "cachedShare", "cost"] as const;

export type CallSort = (typeof CALL_SORTS)[number];

/** Which calls to list, and in what order. Calls missing the sorted value come last either way. */
export type CallQuery = CallFilter & {
  /** The share of input tokens the provider served from cache: at least `atLeast`, below `below`. Calls the
   * provider reported no cache figures for are left out. */
  cachedShare?: { atLeast?: number; below?: number };
  sort?: { by: CallSort; descending: boolean };
};

export type Page = { limit: number; offset: number };

export type CallSummary = {
  id: number;
  time: string;
  kind: string;
  actor: string | null;
  model: string | null;
  provider: string | null;
  status: number | null;
  durationMs: number | null;
  firstTokenMs: number | null;
  usage: Usage;
  promptTokens: number;
  replyPreview: string;
};

export type StoredCall = CallSummary & {
  params: Record<string, unknown>;
  segments: Segment[];
  reply: string;
  reasoning: string;
  meta: Record<string, unknown>;
};

export type KindCount = { kind: string; calls: number };

export type CallStore = {
  /** Store a call; a call whose ref is already stored is left as it is. */
  record(call: RecordedCall): Promise<{ id: number; created: boolean }>;
  /** Newest first, unless the query sorts otherwise. */
  listCalls(query: CallQuery, page: Page): Promise<{ total: number; calls: CallSummary[] }>;
  getCall(id: number): Promise<StoredCall | null>;
  kinds(): Promise<KindCount[]>;
  /** Every matching call's segment references, for the volatility analyses. */
  callRows(filter: CallFilter): Promise<CallRow[]>;
  segmentTexts(hashes: readonly string[]): Promise<Map<string, string>>;
  close(): Promise<void>;
};
