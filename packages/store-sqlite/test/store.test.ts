import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NO_USAGE, toRecordedCall, type CallInput } from "@volatility/core";
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
