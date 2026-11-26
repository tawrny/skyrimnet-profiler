// Replay a call log through the shaping pipeline in order, and measure for each dialogue turn how many tokens
// differ from the same NPC's previous turn (the part a model server must re-read) before and after shaping.
// Run: node test/replay.ts LOG [--trim] [--catalogue] [--reorder]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  approxTokens, classify, DEFAULTS, promptText, shape, sharedPrefix, speaker,
  type CatalogueStore, type ChatRequest,
} from "../src/prompt/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    trim: { type: "boolean" }, catalogue: { type: "boolean" }, reorder: { type: "boolean" },
    warm: { type: "boolean" }, // fill the catalogue with a first pass, as a saved catalogue would be
  },
});
const opts = { ...DEFAULTS, trim: !!values.trim, catalogue: !!values.catalogue, reorder: !!values.reorder };
const store: CatalogueStore = {};
const prevOrig = new Map<string, string>();
const prevShaped = new Map<string, string>();
let turns = 0, origSize = 0, shapedSize = 0, origReread = 0, shapedReread = 0, catalogueChanges = 0;
const lines = readFileSync(positionals[0]!, "utf8").split("\n");
if (values.warm) {
  for (const line of lines) {
    try {
      const r = JSON.parse(line).request as ChatRequest;
      if (r && classify(r).id === "dialogue") shape(structuredClone(r), opts, store);
    } catch { /* skip */ }
  }
}

for (const line of lines) {
  if (!line.trim()) continue;
  let rec: { request?: ChatRequest };
  try { rec = JSON.parse(line); } catch { continue; }
  const original = rec.request;
  if (!original || classify(original).id !== "dialogue") continue;
  const npc = speaker(original);
  if (!npc) continue;
  const shaped = structuredClone(original);
  const report = shape(shaped, opts, store);
  if (report.catalogue && (report.catalogue.added.length || report.catalogue.changed.length)) catalogueChanges++;
  const o = promptText(original), s = promptText(shaped);
  const po = prevOrig.get(npc), ps = prevShaped.get(npc);
  if (po !== undefined && ps !== undefined) {
    turns++;
    origSize += o.length; shapedSize += s.length;
    origReread += o.length - sharedPrefix(o, po);
    shapedReread += s.length - sharedPrefix(s, ps);
  }
  prevOrig.set(npc, o); prevShaped.set(npc, s);
}
const on = Object.entries(values).filter(([, v]) => v).map(([k]) => k).join("+") || "nothing";
console.log(
  `${on.padEnd(22)} ${turns} same-NPC turns | prompt ${approxTokens(origSize / turns)} -> ${approxTokens(shapedSize / turns)} tok` +
  ` | re-read per turn ${approxTokens(origReread / turns)} -> ${approxTokens(shapedReread / turns)} tok` +
  ` | turns that changed a catalogue: ${catalogueChanges}`,
);
