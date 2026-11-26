import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { NO_USAGE, type CallInput } from "@volatility/core";
import { openSqliteStore } from "@volatility/store-sqlite";
import { startApi } from "../src/index.ts";

const turn = (time: string, actor: string, latest: string): CallInput => ({
  time,
  request: {
    messages: [
      { role: "system", content: `You are ${actor}.\n## Rules\nBe brief.` },
      { role: "user", content: latest },
    ],
  },
  reply: "Aye.",
  reasoning: "",
  status: 200,
  durationMs: 900,
  firstTokenMs: 100,
  provider: null,
  usage: NO_USAGE,
  labels: { kind: "dialogue", actor, actorNames: [actor] },
});

const LYDIA_1 = turn("2026-11-27T10:00:00.000Z", "Lydia", "Hello");
const LYDIA_2 = turn("2026-11-27T10:00:05.000Z", "Lydia", "Again");
const MJOLL_1 = turn("2026-11-27T10:00:03.000Z", "Mjoll", "Hello");
const NOT_A_CALL = { time: "now" };

const STATUSES_AFTER_NEW_LINE = ["same", "same", "changed"];
const NO_PREVIOUS = { previous: null };
const OPENING_ACROSS_ACTORS = {
  calls: 3,
  segments: [
    { name: "opening › (text)", acrossActors: { pairs: 2, identical: 0, identicalExceptActor: 2 } },
  ],
};

const BAD_LIST_QUERIES = [
  "limit=ten",
  "sort=mood",
  "sort=time&order=up",
  "cachedAtLeast=2",
  "cachedBelow=-0.1",
  "cachedBelow=",
  "cachedAtLeast=half",
];

const server = startApi(0, openSqliteStore(":memory:"));

await once(server, "listening");
after(() => server.close());

const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0}`;

const get = async (path: string) => {
  const res = await fetch(base + path);

  return { status: res.status, body: await res.json() };
};

const post = async (body: unknown) => {
  const res = await fetch(`${base}/api/calls`, { method: "POST", body: JSON.stringify(body) });

  return { status: res.status, body: await res.json() };
};

describe("POST /api/calls", () => {
  it("ingests a batch, and skips calls already stored", async () => {
    const first = await post([LYDIA_1, MJOLL_1, LYDIA_2]);
    const again = await post(LYDIA_1);

    assert.deepEqual(
      [first.body, again.body],
      [
        { received: 3, created: 3 },
        { received: 1, created: 0 },
      ],
    );
  });

  it("rejects a body that isn't a call", async () => {
    assert.equal((await post(NOT_A_CALL)).status, 400);
  });
});

describe("GET /api/calls/:id", () => {
  it("compares a call with the same actor's previous call", async () => {
    const { body } = await get("/api/calls/3");

    assert.partialDeepStrictEqual(body, { previous: { id: 1, statuses: STATUSES_AFTER_NEW_LINE } });
  });

  it("has no previous call for an actor's first", async () => {
    const { body } = await get("/api/calls/2");

    assert.partialDeepStrictEqual(body, NO_PREVIOUS);
  });

  it("is 404 for an unknown call", async () => {
    assert.equal((await get("/api/calls/99")).status, 404);
  });
});

describe("GET /api/volatility", () => {
  it("reports each segment of the kind, the actor's own text identical once names are replaced", async () => {
    const { body } = await get("/api/volatility?kind=dialogue");

    assert.partialDeepStrictEqual(body, OPENING_ACROSS_ACTORS);
  });
});

describe("GET /api/calls", () => {
  for (const query of BAD_LIST_QUERIES) {
    it(`rejects ${query}`, async () => {
      assert.equal((await get(`/api/calls?${query}`)).status, 400);
    });
  }

  it("sorts as asked", async () => {
    const { body } = await get("/api/calls?sort=time&order=asc");

    assert.partialDeepStrictEqual(body, {
      calls: [{ time: LYDIA_1.time }, { time: MJOLL_1.time }, { time: LYDIA_2.time }],
    });
  });

  it("filters by cache share, leaving out calls with no cache figures", async () => {
    const { body } = await get("/api/calls?cachedAtLeast=0&cachedBelow=1");

    assert.partialDeepStrictEqual(body, { total: 0 });
  });
});
