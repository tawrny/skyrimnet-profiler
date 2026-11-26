import { test } from "node:test";
import assert from "node:assert/strict";
import { reach, seen, type ChatRequest, type MatchKind, type Seen } from "../src/prompt/index.ts";

const dialogue = (npc: string, time: string): ChatRequest => ({
  messages: [
    { role: "system", content: `You are ${npc}, a Female Nord in Skyrim.\nBio.` },
    { role: "user", content: "Tawrny: hello" },
    {
      role: "user",
      content: [
        "# Setting",
        "## Inventory",
        "- Iron Sword",
        "## Current Time",
        time,
        "## Task",
        "Reply.",
      ].join("\n"),
    },
  ],
});
const mood = (npc: string): ChatRequest => ({
  messages: [{ role: "system", content: `You are an AI mood analyzer for ${npc}.` }],
});

const lydiaAt3 = dialogue("Lydia", "3 PM");
const lydiaAt4 = dialogue("Lydia", "4 PM");
const riaAt3 = dialogue("Ria", "3 PM");
const lydiaMood = mood("Lydia");

const matchCases: [string, Seen[], MatchKind | null][] = [
  ["nothing earlier", [], null],
  ["another NPC's dialogue", [seen(riaAt3)], "same job"],
  ["the same NPC's dialogue beats another NPC's", [seen(riaAt3), seen(lydiaAt3)], "same NPC"],
  ["another job's prompt", [seen(lydiaMood)], "other job"],
];

for (const [name, earlier, expected] of matchCases) {
  test(`reach names the earlier call with the longest shared prefix: ${name}`, () => {
    assert.equal(reach(lydiaAt4, earlier).match, expected);
  });
}

test("reach measures the prefix up to the first changed character", () => {
  const r = reach(lydiaAt4, [seen(riaAt3), seen(lydiaAt3)]);
  const text = seen(lydiaAt4).text;

  assert.equal(r.sharedChars, text.indexOf("4 PM"));
  assert.equal(r.promptChars, text.length);
});

const breakCases: [string, Seen[], string][] = [
  ["the section holding the first difference", [seen(lydiaAt3)], "volatile: Current Time"],
  ["the opening when nothing is shared", [], "system: Bio and rules"],
  ["the whole prompt when nothing differs", [seen(lydiaAt4)], "whole prompt"],
];

for (const [name, earlier, expected] of breakCases) {
  test(`reach says where the reusable prefix ends: ${name}`, () => {
    assert.equal(reach(lydiaAt4, earlier).breaksIn, expected);
  });
}
