import { test } from "node:test";
import assert from "node:assert/strict";
import {
  anatomy, applyCatalogue, CATALOGUE_HEADING, classify, DEFAULTS, moveStableToSystem, promptText, shape,
  split, trim, type CatalogueStore, type ChatRequest,
} from "../src/prompt/index.ts";

const ACTIONS = [
  "## Actions Available",
  "**Available Actions:**",
  "- `Economy` — Category: money changing hands now. Not here: unpriced hand-overs (Items).",
  "- `Clean` PARAMS: {\"target\":\"Who. Valid Choices: 'Tawrny', 'Lydia'. Choose one of these actor names EXACTLY.\"} — Cleans someone. Only when messy.",
  "- `TriggerDialogueLine` PARAMS: {\"form_id\":\"code\"} —",
  "The exchanges below are actions Lydia can trigger right now: [0001] Rent a room.",
  "",
  "**Guidelines:**",
  "- Only use an action if it fits",
].join("\n");

const context = (activity: string, time: string) =>
  [
    "# Setting",
    "## Lydia's Current State (THIS IS YOU)",
    "## Physical Activity",
    `- Lydia is ${activity}.`,
    "## Lydia's Inventory",
    "- Iron Sword",
    "## Current Time",
    `**Time**: ${time}`,
    "## Task",
    "Respond as Lydia.",
    ACTIONS,
  ].join("\n");

const dialogue = (activity: string, time: string, history: string[]): ChatRequest => ({
  messages: [
    { role: "system", content: "You are Lydia, a Female Nord in Skyrim.\nBio." },
    ...history.map((h) => ({ role: "user", content: h })),
    { role: "user", content: context(activity, time) },
  ],
  max_tokens: 4096,
});

test("split keeps stable sections and moves volatile ones, with their owner, before the task", () => {
  const [stable, rest] = split(context("standing", "3 PM"))!;
  assert.match(stable, /## Lydia's Inventory/);
  assert.doesNotMatch(stable, /Physical Activity|Current Time/);
  assert.match(rest, /^## Physical Activity \(Lydia, you\)\n- Lydia is standing\.\n## Current Time/);
  assert.ok(rest.indexOf("## Current Time") < rest.indexOf("## Task"));
});

test("moveStableToSystem puts stable context ahead of the history", () => {
  const r = dialogue("standing", "3 PM", ["Tawrny: hello"]);
  assert.ok(moveStableToSystem(r));
  assert.match(String(r.messages![0]!.content), /Bio\.\n\n# Setting\n## Lydia's Current State/);
  assert.doesNotMatch(String(r.messages!.at(-1)!.content), /Inventory/);
});

test("trim lists actor names once and keeps each description's first sentence", () => {
  const t = trim(ACTIONS);
  assert.match(t, /\*\*Available Actions:\*\*\nNearby actors: Tawrny, Lydia\./);
  assert.match(t, /`Economy` — Category: money changing hands now\.\n/);
  assert.match(t, /Must be a name from the Nearby actors line above, exactly\./);
  assert.match(t, /The exchanges below are actions Lydia can trigger/); // TriggerDialogueLine kept whole
});

test("the catalogue moves entries to the system message and keeps live entries at the end", () => {
  const store: CatalogueStore = {};
  const r = dialogue("standing", "3 PM", []);
  const res = applyCatalogue(r, "Lydia", store);
  assert.deepEqual(res.added.sort(), ["Clean", "Economy"]);
  const system = String(r.messages![0]!.content);
  const last = String(r.messages!.at(-1)!.content);
  assert.match(system, new RegExp(`${CATALOGUE_HEADING}\\n`));
  assert.ok(system.indexOf("`Clean`") < system.indexOf("`Economy`")); // sorted
  assert.match(last, /Available now: `Economy`, `Clean`, `TriggerDialogueLine`\./);
  assert.match(last, /Nearby actors: Tawrny, Lydia\./);
  assert.match(last, /trigger right now: \[0001\]/); // TriggerDialogueLine stays live
  assert.doesNotMatch(last, /Category: money/);
});

test("a second turn with different targets and quest lines leaves the catalogue unchanged", () => {
  const store: CatalogueStore = {};
  const a = dialogue("standing", "3 PM", []);
  const b = dialogue("sitting", "4 PM", ["Tawrny: hi"]);
  b.messages!.at(-1)!.content = String(b.messages!.at(-1)!.content)
    .replace("'Tawrny', 'Lydia'", "'Tawrny', 'Lydia', 'Hulda'")
    .replace("[0001] Rent a room.", "[0002] Buy a drink.");
  applyCatalogue(a, "Lydia", store);
  const res = applyCatalogue(b, "Lydia", store);
  assert.deepEqual(res, { applied: true, added: [], changed: [] });
  const sysA = String(a.messages![0]!.content);
  const sysB = String(b.messages![0]!.content);
  assert.equal(sysA, sysB);
});

test("shape: thinking off for structured jobs, on for dialogue and pickers; max_tokens capped", () => {
  const mood: ChatRequest = { messages: [{ role: "system", content: "You are an AI mood analyzer for Skyrim." }], max_tokens: 4096 };
  const picker: ChatRequest = { messages: [{ role: "system", content: "Determine which NPC the player is addressing." }] };
  const store: CatalogueStore = {};
  shape(mood, DEFAULTS, store);
  shape(picker, DEFAULTS, store);
  assert.deepEqual(mood.chat_template_kwargs, { enable_thinking: false });
  assert.equal(mood.max_tokens, 1024);
  assert.deepEqual(mood.stop, ["</s>", "<|tool_response>"]);
  assert.equal(picker.chat_template_kwargs, undefined);
  assert.equal(classify(dialogue("x", "y", [])).id, "dialogue");
});

test("anatomy spans cover the whole prompt text exactly", () => {
  const r = dialogue("standing", "3 PM", ["Tawrny: hello", "Lydia: hm"]);
  applyCatalogue(r, "Lydia", {});
  moveStableToSystem(r);
  const spans = anatomy(r);
  const total = spans.reduce((n, s) => n + s.length, 0);
  assert.equal(total, promptText(r).length);
  assert.ok(spans.some((s) => s.kind === "catalogue"));
  assert.ok(spans.some((s) => s.kind === "history"));
  assert.ok(spans.some((s) => s.kind === "volatile"));
});
