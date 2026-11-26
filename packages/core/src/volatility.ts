// The three questions, asked of every segment of every kind of call:
//  - over time: for the same actor (or, with no actors, the same kind), how often does it change between calls?
//  - across actors: compared with the latest call of the same kind for another actor, is it identical? Identical
//    once actor names are replaced?
//  - within: when it changes, is it only appended to, and what share of its lines change?

import { changedShare, lineChange } from "./lines.ts";

export type SegmentRef = {
  position: number;
  name: string;
  hash: string;
  templateHash: string;
  tokens: number;
};

/** A call as the analyses need it: when, what kind, for whom, and its segments. */
export type CallRow = {
  id: number;
  time: string;
  kind: string;
  actor: string | null;
  segments: SegmentRef[];
};

export type SegmentVolatility = {
  kind: string;
  name: string;
  calls: number;
  avgTokens: number;
  /** Mean position in the prompt, to list segments in prompt order. */
  avgPosition: number;
  overTime: {
    pairs: number;
    changed: number;
    appendOnly: number;
    avgChangedLineShare: number | null;
  };
  acrossActors: { pairs: number; identical: number; identicalExceptActor: number };
};

type CallPair = { earlier: CallRow; later: CallRow };

type Tally = {
  kind: string;
  name: string;
  calls: number;
  tokens: number;
  positions: number;
  timePairs: number;
  changed: number;
  appendOnly: number;
  lineShareSum: number;
  lineShareCount: number;
  actorPairs: number;
  identical: number;
  identicalExceptActor: number;
};

const byTime = (calls: readonly CallRow[]) =>
  [...calls].sort((a, b) => a.time.localeCompare(b.time) || a.id - b.id);

/** Each call with the previous call of the same kind and actor (the same kind alone, when there's no actor). */
export function overTimePairs(calls: readonly CallRow[]): CallPair[] {
  const last = new Map<string, CallRow>();
  const pairs: CallPair[] = [];

  for (const call of byTime(calls)) {
    const key = `${call.kind}\u0000${call.actor ?? ""}`;
    const earlier = last.get(key);

    if (earlier) {
      pairs.push({ earlier, later: call });
    }

    last.set(key, call);
  }

  return pairs;
}

/** Each call with the latest earlier call of the same kind for a different actor. Calls without an actor have none. */
export function acrossActorPairs(calls: readonly CallRow[]): CallPair[] {
  const latestByKind = new Map<string, Map<string, CallRow>>();
  const pairs: CallPair[] = [];

  for (const call of byTime(calls)) {
    if (call.actor === null) {
      continue;
    }

    const byActor = latestByKind.get(call.kind) ?? new Map<string, CallRow>();
    const others = [...byActor.values()].filter((c) => c.actor !== call.actor);
    const earlier = others.reduce<CallRow | null>(
      (latest, c) => (latest === null || c.time > latest.time ? c : latest),
      null,
    );

    if (earlier) {
      pairs.push({ earlier, later: call });
    }

    byActor.set(call.actor, call);
    latestByKind.set(call.kind, byActor);
  }

  return pairs;
}

export type SegmentStatus = "same" | "changed" | "new";

export type Comparison = {
  /** One per segment of the later call, in its order. */
  statuses: SegmentStatus[];
  /** Tokens before the first segment that differs from the earlier call's at the same position: what a prefix cache
   * could reuse. */
  stablePrefixTokens: number;
};

export function compare(earlier: readonly SegmentRef[], later: readonly SegmentRef[]): Comparison {
  const before = new Map(earlier.map((s) => [s.name, s.hash]));
  const statuses = later.map((s): SegmentStatus => {
    const old = before.get(s.name);

    if (old === undefined) {
      return "new";
    }

    return old === s.hash ? "same" : "changed";
  });
  const firstDiffering = later.findIndex((s, i) => earlier[i]?.hash !== s.hash);
  const stable = firstDiffering === -1 ? later : later.slice(0, firstDiffering);

  return { statuses, stablePrefixTokens: stable.reduce((sum, s) => sum + s.tokens, 0) };
}

/** The latest call before this one with the same kind and actor. */
export function previousCall(calls: readonly CallRow[], call: CallRow): CallRow | null {
  const earlier = byTime(calls).filter(
    (c) =>
      c.kind === call.kind &&
      c.actor === call.actor &&
      (c.time < call.time || (c.time === call.time && c.id < call.id)),
  );

  return earlier.at(-1) ?? null;
}

/** Hashes whose text the within-segment analysis needs: both versions of every segment that changed over time. */
export function textsNeeded(calls: readonly CallRow[]): string[] {
  const hashes = new Set<string>();

  for (const { earlier, later } of overTimePairs(calls)) {
    const before = new Map(earlier.segments.map((s) => [s.name, s.hash]));

    for (const s of later.segments) {
      const old = before.get(s.name);

      if (old !== undefined && old !== s.hash) {
        hashes.add(old);
        hashes.add(s.hash);
      }
    }
  }

  return [...hashes];
}

export function volatilityReport(
  calls: readonly CallRow[],
  texts: ReadonlyMap<string, string>,
): SegmentVolatility[] {
  const tallies = new Map<string, Tally>();

  const tally = (kind: string, name: string): Tally => {
    const key = `${kind}\u0000${name}`;
    const found = tallies.get(key);

    if (found) {
      return found;
    }

    const fresh: Tally = {
      kind,
      name,
      calls: 0,
      tokens: 0,
      positions: 0,
      timePairs: 0,
      changed: 0,
      appendOnly: 0,
      lineShareSum: 0,
      lineShareCount: 0,
      actorPairs: 0,
      identical: 0,
      identicalExceptActor: 0,
    };

    tallies.set(key, fresh);

    return fresh;
  };

  for (const call of calls) {
    for (const s of call.segments) {
      const t = tally(call.kind, s.name);

      t.calls++;
      t.tokens += s.tokens;
      t.positions += s.position;
    }
  }

  for (const { earlier, later } of overTimePairs(calls)) {
    const before = new Map(earlier.segments.map((s) => [s.name, s.hash]));

    for (const s of later.segments) {
      const t = tally(later.kind, s.name);
      const old = before.get(s.name);

      t.timePairs++;

      if (old === s.hash) {
        continue;
      }

      t.changed++;
      const oldText = old === undefined ? undefined : texts.get(old);
      const newText = texts.get(s.hash);

      if (oldText === undefined || newText === undefined) {
        continue;
      }

      const change = lineChange(oldText, newText);

      if (change.appendOnly) {
        t.appendOnly++;
      }

      t.lineShareSum += changedShare(change);
      t.lineShareCount++;
    }
  }

  for (const { earlier, later } of acrossActorPairs(calls)) {
    const other = new Map(earlier.segments.map((s) => [s.name, s]));

    for (const s of later.segments) {
      const t = tally(later.kind, s.name);
      const match = other.get(s.name);

      t.actorPairs++;

      if (match?.hash === s.hash) {
        t.identical++;
      }

      if (match?.templateHash === s.templateHash) {
        t.identicalExceptActor++;
      }
    }
  }

  return [...tallies.values()]
    .map(toVolatility)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.avgPosition - b.avgPosition);
}

function toVolatility(t: Tally): SegmentVolatility {
  return {
    kind: t.kind,
    name: t.name,
    calls: t.calls,
    avgTokens: Math.round(t.tokens / t.calls),
    avgPosition: t.positions / t.calls,
    overTime: {
      pairs: t.timePairs,
      changed: t.changed,
      appendOnly: t.appendOnly,
      avgChangedLineShare: t.lineShareCount === 0 ? null : t.lineShareSum / t.lineShareCount,
    },
    acrossActors: {
      pairs: t.actorPairs,
      identical: t.identical,
      identicalExceptActor: t.identicalExceptActor,
    },
  };
}
