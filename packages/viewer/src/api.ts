// The profiler API's responses, typed from core. The viewer trusts its own API, so the JSON isn't validated.

import type {
  CallSort,
  CallSummary,
  Comparison,
  KindCount,
  SegmentVolatility,
  StoredCall,
} from "@volatility/core";

export type {
  CallSort,
  CallSummary,
  KindCount,
  SegmentStatus,
  SegmentVolatility,
  StoredCall,
} from "@volatility/core";

export type CallDetail = {
  call: StoredCall;
  previous: (Comparison & { id: number }) | null;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);

  if (!res.ok) {
    throw new Error(`${path}: ${res.status}`);
  }

  const body: T = await res.json();

  return body;
}

const query = (params: Record<string, string | number | null>) => {
  const search = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v !== null) {
      search.set(k, String(v));
    }
  }

  return search.toString();
};

export type ListOptions = {
  kind: string | null;
  sort: CallSort;
  descending: boolean;
  cachedAtLeast: number | null;
  cachedBelow: number | null;
};

export const api = {
  kinds: () => get<KindCount[]>("/api/kinds"),
  calls: (o: ListOptions, limit = 500) =>
    get<{ total: number; calls: CallSummary[] }>(
      `/api/calls?${query({
        kind: o.kind,
        sort: o.sort,
        order: o.descending ? "desc" : "asc",
        cachedAtLeast: o.cachedAtLeast,
        cachedBelow: o.cachedBelow,
        limit,
      })}`,
    ),
  call: (id: number) => get<CallDetail>(`/api/calls/${id}`),
  volatility: (kind: string | null) =>
    get<{ calls: number; segments: SegmentVolatility[] }>(`/api/volatility?${query({ kind })}`),
};
