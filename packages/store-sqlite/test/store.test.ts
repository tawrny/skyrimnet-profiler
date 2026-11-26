import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NO_USAGE,
  toRecordedCall,
  type CallInput,
  type CallQuery,
  type RecordedCall,
} from "@volatility/core";
import { openSqliteStore } from "../src/index.ts";

const call = (time: string, actor: string, latest: string): CallInput => ({
  time,
  request: {
    model: "m",
    temperature: 0.2,
    messages: [
      { role: "system", content: `You are ${actor}.\n## Rules\nBe brief.` },
      { role: "user", content: latest },
    ],
  },
  reply: "Aye.",
  reasoning: "",
  status: 200,
  durationMs: 900,
  firstTokenMs: 120,
  provider: "DeepInfra",
  usage: { ...NO_USAGE, inputTokens: 40, cachedInputTokens: 30 },
  labels: { kind: "dialogue", actor, actorNames: [actor] },
  meta: { shaping: { trim: true } },
});

const LYDIA_1 = toRecordedCall(call("2026-11-27T10:00:00Z", "Lydia", "Hello"));
const LYDIA_2 = toRecordedCall(call("2026-11-27T10:00:05Z", "Lydia", "Again"));
const MJOLL_1 = toRecordedCall(call("2026-11-27T10:00:03Z", "Mjoll", "Hello"));
const UNLABELLED = toRecordedCall({
  ...call("2026-11-27T10:00:09Z", "Ann", "Hi"),
  labels: undefined,
});

// Five calls for filtering and sorting, oldest first. Each sorts differently by every key; D and E have no cache
// share (no usage figures, and zero input tokens), D and E no cost.
const profiled = (
  time: string,
  latest: string,
  durationMs: number,
  usage: Partial<CallInput["usage"]>,
) =>
  toRecordedCall({
    ...call(`2026-11-27T11:00:0${time}Z`, "Lydia", latest),
    durationMs,
    usage: { ...NO_USAGE, ...usage },
  });

const A = profiled("1", "x".repeat(400), 500, {
  inputTokens: 100,
  cachedInputTokens: 10,
  costUsd: 0.003,
});
const B = profiled("2", "x".repeat(40), 3000, {
  inputTokens: 100,
  cachedInputTokens: 50,
  costUsd: 0.001,
});
const C = profiled("3", "x".repeat(4000), 1000, {
  inputTokens: 100,
  cachedInputTokens: 90,
  costUsd: 0.002,
});
const D = profiled("4", "x".repeat(800), 2000, {});
const E = profiled("5", "x".repeat(1200), 4000, { inputTokens: 0, cachedInputTokens: 0 });
const PROFILED = [A, B, C, D, E];

const CACHE_FILTERS: [string, CallQuery["cachedShare"], RecordedCall[]][] = [
  ["below a share", { below: 0.2 }, [A]],
  ["at least a share, inclusive", { atLeast: 0.5 }, [C, B]],
  ["between, the upper bound exclusive", { atLeast: 0.1, below: 0.9 }, [B, A]],
  ["any share, leaving out calls without one", {}, [C, B, A]],
];

const SORTS: [CallQuery["sort"], RecordedCall[]][] = [
  [{ by: "time", descending: false }, [A, B, C, D, E]],
  [{ by: "duration", descending: true }, [E, B, D, C, A]],
  [{ by: "promptTokens", descending: true }, [C, E, D, A, B]],
  [{ by: "cachedShare", descending: false }, [A, B, C, D, E]],
  [{ by: "cachedShare", descending: true }, [C, B, A, E, D]],
  [{ by: "cost", descending: false }, [B, C, A, D, E]],
];

async function storeWith(...calls: (typeof LYDIA_1)[]) {
  const store = openSqliteStore(":memory:");

  for (const c of calls) {
    await store.record(c);
  }

  return store;
}

describe("record", () => {
  it("stores a call once, however often it's recorded", async () => {
    const store = await storeWith(LYDIA_1);
    const again = await store.record(LYDIA_1);
    const { total } = await store.listCalls({}, { limit: 10, offset: 0 });

    assert.deepEqual([again.created, total], [false, 1]);
  });
});

describe("getCall", () => {
  it("returns the call as recorded, segments in prompt order", async () => {
    const store = await storeWith(LYDIA_1);
    const stored = await store.getCall(1);

    assert.deepEqual(stored?.segments, LYDIA_1.segments);
    assert.deepEqual(
      [stored?.params, stored?.meta, stored?.usage, stored?.reply],
      [LYDIA_1.params, LYDIA_1.meta, LYDIA_1.usage, LYDIA_1.reply],
    );
  });

  it("returns null for an unknown id", async () => {
    const store = await storeWith();

    assert.equal(await store.getCall(7), null);
  });
});

describe("listCalls", () => {
  it("lists newest first, filtered by kind and actor, with the total before paging", async () => {
    const store = await storeWith(LYDIA_1, MJOLL_1, LYDIA_2, UNLABELLED);
    const page = await store.listCalls(
      { kind: "dialogue", actor: "Lydia" },
      { limit: 1, offset: 0 },
    );

    assert.deepEqual([page.total, page.calls.map((c) => c.time)], [2, [LYDIA_2.time]]);
  });

  for (const [name, cachedShare, expected] of CACHE_FILTERS) {
    it(`filters by cache share: ${name}`, async () => {
      const store = await storeWith(...PROFILED);
      const page = await store.listCalls({ cachedShare }, { limit: 10, offset: 0 });

      assert.deepEqual(
        [page.total, page.calls.map((c) => c.time)],
        [expected.length, expected.map((c) => c.time)],
      );
    });
  }

  for (const [sort, expected] of SORTS) {
    it(`sorts by ${sort?.by}, ${sort?.descending ? "descending" : "ascending"}, missing values last`, async () => {
      const store = await storeWith(...PROFILED);
      const page = await store.listCalls({ sort }, { limit: 10, offset: 0 });

      assert.deepEqual(
        page.calls.map((c) => c.time),
        expected.map((c) => c.time),
      );
    });
  }

  it("sums the prompt's segment tokens", async () => {
    const store = await storeWith(LYDIA_1);
    const { calls } = await store.listCalls({}, { limit: 1, offset: 0 });
    const expected = LYDIA_1.segments.reduce((sum, s) => sum + s.tokens, 0);

    assert.equal(calls[0]?.promptTokens, expected);
  });
});

describe("kinds", () => {
  it("counts calls per kind, most first", async () => {
    const store = await storeWith(LYDIA_1, MJOLL_1, UNLABELLED);

    assert.deepEqual(await store.kinds(), [
      { kind: "dialogue", calls: 2 },
      { kind: UNLABELLED.kind, calls: 1 },
    ]);
  });
});

describe("callRows", () => {
  it("gives each matching call's segment references in time order", async () => {
    const store = await storeWith(LYDIA_2, MJOLL_1, LYDIA_1, UNLABELLED);
    const rows = await store.callRows({ kind: "dialogue" });

    assert.deepEqual(
      rows.map((r) => [r.actor, r.segments.map((s) => s.hash)]),
      [LYDIA_1, MJOLL_1, LYDIA_2].map((c) => [c.actor, c.segments.map((s) => s.hash)]),
    );
  });
});

describe("segmentTexts", () => {
  it("returns the text for each known hash, skipping unknown ones", async () => {
    const store = await storeWith(LYDIA_1);
    const [first] = LYDIA_1.segments;
    const texts = await store.segmentTexts(["missing", first?.hash ?? ""]);

    assert.deepEqual([...texts], [[first?.hash, first?.text]]);
  });
});
