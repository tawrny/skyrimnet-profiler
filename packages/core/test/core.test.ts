import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deName,
  isCallInput,
  lineChange,
  NO_USAGE,
  pieces,
  segmentRequest,
  toRecordedCall,
  volatilityReport,
  type CallInput,
  type CallRow,
  type ChatRequest,
  type SegmentRef,
} from "../src/index.ts";

// deName

const LYDIA = ["Lydia"];
const LYDIA_GRAY = ["Lydia", "Lydia Gray"];
const ONE_LETTER = ["A"];

const deNameCases: [string, readonly string[], string][] = [
  ["You are Lydia.", LYDIA, "You are {actor}."],
  ["Lydia Gray, and Lydia", LYDIA_GRAY, "{actor}, and {actor}"],
  ["A cat", ONE_LETTER, "A cat"],
];

describe("deName", () => {
  for (const [text, names, expected] of deNameCases) {
    it(`replaces ${names.join(", ")} in "${text}"`, () => {
      assert.equal(deName(text, names), expected);
    });
  }
});

// pieces

const PREAMBLE_AND_HEADINGS = "intro\n## One\na\n### Two\nb";
const ONLY_HEADINGS = "## One\na";
const PLAIN = "just text";

const piecesCases: [string, string[]][] = [
  [PREAMBLE_AND_HEADINGS, ["(text)", "One", "Two"]],
  [ONLY_HEADINGS, ["One"]],
  [PLAIN, ["(text)"]],
];

describe("pieces", () => {
  for (const [text, titles] of piecesCases) {
    it(`splits ${JSON.stringify(text)} into ${titles.join(", ")}`, () => {
      assert.deepEqual(
        pieces(text).map((p) => p.title),
        titles,
      );
    });
  }

  it("keeps every character", () => {
    assert.equal(
      pieces(PREAMBLE_AND_HEADINGS)
        .map((p) => p.text)
        .join(""),
      PREAMBLE_AND_HEADINGS,
    );
  });
});

// segmentRequest

const CONVERSATION: ChatRequest = {
  messages: [
    { role: "system", content: "You are Lydia.\n## Rules\nBe brief.\n## Rules\nStill brief." },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    { role: "user", content: "## Lydia's turn\nSpeak." },
  ],
};

const SINGLE: ChatRequest = { messages: [{ role: "user", content: "Only this" }] };

const CONVERSATION_NAMES = [
  "opening › (text)",
  "opening › Rules",
  "opening › Rules (2)",
  "history › messages",
  "latest › {actor}'s turn",
];

const LYDIA_PROMPT: ChatRequest = { messages: [{ role: "system", content: "You are Lydia." }] };
const MJOLL_PROMPT: ChatRequest = { messages: [{ role: "system", content: "You are Mjoll." }] };

describe("segmentRequest", () => {
  it("names the opening's headings, the history and the latest message, numbering repeats", () => {
    assert.deepEqual(
      segmentRequest(CONVERSATION, LYDIA).map((s) => s.name),
      CONVERSATION_NAMES,
    );
  });

  it("joins the messages between the first and last into one history segment", () => {
    assert.equal(segmentRequest(CONVERSATION, LYDIA)[3]?.text, "[user]\nHi\n[assistant]\nHello");
  });

  it("treats a single message as the opening, with no latest", () => {
    assert.deepEqual(
      segmentRequest(SINGLE, []).map((s) => s.name),
      ["opening › (text)"],
    );
  });

  it("gives two actors' otherwise identical text different hashes and the same template hash", () => {
    const [lydia] = segmentRequest(LYDIA_PROMPT, ["Lydia"]);
    const [mjoll] = segmentRequest(MJOLL_PROMPT, ["Mjoll"]);

    assert.notEqual(lydia?.hash, mjoll?.hash);
    assert.equal(lydia?.templateHash, mjoll?.templateHash);
  });
});

// lineChange

const BEFORE = "a\nb\nc";
const APPENDED = "a\nb\nc\nd";
const EDITED = "a\nB\nc";
const REORDERED = "c\na\nb";
const INSERTED = "a\nx\nb\nc";

const lineChangeCases: [string, string, boolean, string[], string[]][] = [
  [BEFORE, APPENDED, true, ["d"], []],
  [BEFORE, INSERTED, false, ["x"], []],
  [BEFORE, EDITED, false, ["B"], ["b"]],
  [BEFORE, REORDERED, false, [], []],
];

describe("lineChange", () => {
  for (const [before, after, appendOnly, added, removed] of lineChangeCases) {
    it(`${JSON.stringify(before)} → ${JSON.stringify(after)}`, () => {
      const change = lineChange(before, after);

      assert.equal(change.appendOnly, appendOnly);
      assert.deepEqual(change.added, added);
      assert.deepEqual(change.removed, removed);
    });
  }
});

// volatilityReport

const seg = (name: string, hash: string, templateHash: string = hash): SegmentRef => ({
  position: 0,
  name,
  hash,
  templateHash,
  tokens: 10,
});

const row = (id: number, actor: string | null, segments: SegmentRef[]): CallRow => ({
  id,
  time: `2026-11-27T00:00:0${id}Z`,
  kind: "dialogue",
  actor,
  segments,
});

// Lydia twice (her rules unchanged, her bio appended to), then Mjoll (rules identical, bio identical bar the name).
const CALLS: CallRow[] = [
  row(1, "Lydia", [seg("rules", "r"), seg("bio", "b1", "t1")]),
  row(2, "Lydia", [seg("rules", "r"), seg("bio", "b2", "t2")]),
  row(3, "Mjoll", [seg("rules", "r"), seg("bio", "m2", "t2")]),
];

const TEXTS = new Map([
  ["b1", "Lydia is a housecarl."],
  ["b2", "Lydia is a housecarl.\nShe is tired."],
]);

const UNNAMED_CALLS: CallRow[] = [
  row(1, null, [seg("rules", "r1")]),
  row(2, null, [seg("rules", "r2")]),
];

const MIXED_CALLS: CallRow[] = [
  row(1, "Lydia", [seg("rules", "r")]),
  row(2, null, [seg("rules", "r")]),
];

const report = volatilityReport(CALLS, TEXTS);
const rules = report.find((v) => v.name === "rules");
const bio = report.find((v) => v.name === "bio");

describe("volatilityReport", () => {
  it("counts a segment as changed over time only when the same actor's text differs", () => {
    assert.deepEqual([rules?.overTime.pairs, rules?.overTime.changed], [1, 0]);
    assert.deepEqual([bio?.overTime.pairs, bio?.overTime.changed], [1, 1]);
  });

  it("marks a change that only appended as append-only, with its share of changed lines", () => {
    assert.equal(bio?.overTime.appendOnly, 1);
    assert.equal(bio?.overTime.avgChangedLineShare, 1 / 3);
  });

  it("compares across actors as written and with names replaced", () => {
    assert.deepEqual(rules?.acrossActors, { pairs: 1, identical: 1, identicalExceptActor: 1 });
    assert.deepEqual(bio?.acrossActors, { pairs: 1, identical: 0, identicalExceptActor: 1 });
  });

  it("pairs calls with no actor by kind over time, and never across actors", () => {
    const [unnamed] = volatilityReport(UNNAMED_CALLS, new Map());

    assert.deepEqual([unnamed?.overTime.changed, unnamed?.acrossActors.pairs], [1, 0]);
  });

  it("doesn't pair a call with no actor against another actor's", () => {
    const [mixed] = volatilityReport(MIXED_CALLS, new Map());

    assert.equal(mixed?.acrossActors.pairs, 0);
  });
});

// toRecordedCall and isCallInput

const INPUT: CallInput = {
  time: "2026-11-27T00:00:00Z",
  request: {
    model: "m",
    temperature: 0.5,
    messages: [{ role: "system", content: "Opening line\nmore" }],
  },
  reply: "ok",
  reasoning: "",
  status: 200,
  durationMs: 1000,
  firstTokenMs: 100,
  provider: "p",
  usage: NO_USAGE,
};

const LABELLED: CallInput = {
  ...INPUT,
  labels: { kind: "chat", actor: "Ann", actorNames: ["Ann"] },
};

describe("toRecordedCall", () => {
  it("keeps the request's parameters apart from its messages", () => {
    assert.deepEqual(toRecordedCall(INPUT).params, { model: "m", temperature: 0.5 });
  });

  it("labels an unlabelled call by its opening line, with no actor", () => {
    const call = toRecordedCall(INPUT);

    assert.deepEqual([call.kind, call.actor], ["Opening line", null]);
  });

  it("uses the labels a source gave", () => {
    const call = toRecordedCall(LABELLED);

    assert.deepEqual([call.kind, call.actor], ["chat", "Ann"]);
  });

  it("gives the same call the same ref, so it records once", () => {
    assert.equal(toRecordedCall(INPUT).ref, toRecordedCall(LABELLED).ref);
  });
});

const MISSING_USAGE = { ...INPUT, usage: undefined };
const BAD_LABELS = { ...INPUT, labels: { kind: "chat", actor: 3, actorNames: [] } };
const BAD_MESSAGES = { ...INPUT, request: { messages: [{ content: "no role" }] } };

const isCallInputCases: [string, unknown, boolean][] = [
  ["a full call", INPUT, true],
  ["a labelled call", LABELLED, true],
  ["missing usage", MISSING_USAGE, false],
  ["labels with a numeric actor", BAD_LABELS, false],
  ["a message without a role", BAD_MESSAGES, false],
];

describe("isCallInput", () => {
  for (const [name, input, expected] of isCallInputCases) {
    it(`${expected ? "accepts" : "rejects"} ${name}`, () => {
      assert.equal(isCallInput(input), expected);
    });
  }
});
