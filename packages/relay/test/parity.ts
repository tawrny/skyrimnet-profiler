// Compare the TypeScript prompt shapers with the Python originals (legacy/) on real requests.
// Input: a JSONL of {original, trim, reorder} written by the Python versions. Run: node test/parity.ts FILE

import { readFileSync } from "node:fs";
import { moveStableToSystem, trimRequest, type ChatRequest } from "../src/prompt/index.ts";

const file = process.argv[2];

if (!file) {
  throw new Error("usage: node test/parity.ts parity.jsonl");
}

let n = 0;
const fails = { trim: 0, reorder: 0 };

for (const line of readFileSync(file, "utf8").split("\n")) {
  if (!line.trim()) {
    continue;
  }

  const { original, trim, reorder } = JSON.parse(line) as Record<string, ChatRequest>;

  n++;
  const t = structuredClone(original!);

  trimRequest(t);

  if (JSON.stringify(t) !== JSON.stringify(trim)) {
    if (fails.trim++ === 0) {
      firstDiff("trim", JSON.stringify(trim), JSON.stringify(t));
    }
  }

  const o = structuredClone(original!);

  moveStableToSystem(o);

  if (JSON.stringify(o) !== JSON.stringify(reorder)) {
    if (fails.reorder++ === 0) {
      firstDiff("reorder", JSON.stringify(reorder), JSON.stringify(o));
    }
  }
}

console.log(`${n} requests | trim mismatches ${fails.trim} | reorder mismatches ${fails.reorder}`);
process.exitCode = fails.trim || fails.reorder ? 1 : 0;

function firstDiff(what: string, py: string, ts: string): void {
  let i = 0;

  while (i < py.length && py[i] === ts[i]) {
    i++;
  }

  console.log(
    `${what}: first difference at ${i}\n  python: ${JSON.stringify(py.slice(i - 60, i + 80))}\n  ts:     ${JSON.stringify(ts.slice(i - 60, i + 80))}`,
  );
}
