// Cache reach over a call log: for each job (and provider, when logged), how much of each prompt an ideal prefix
// cache could have served from the calls before it, how much the provider says it did serve, and the sections
// where the reusable prefix most often ends, weighted by the tokens re-read after them.
// Run: node test/cache.ts LOG [--window 5] [--top 6] [--since "2026-11-26 20:00"]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { approxTokens, reach, seen, type ChatRequest, type Seen } from "../src/prompt/index.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    window: { type: "string", default: "5" },
    top: { type: "string", default: "6" },
    since: { type: "string" },
  },
});
const windowMs = Number(values.window) * 60_000;
const top = Number(values.top);

type Rec = {
  time: string;
  request?: ChatRequest;
  provider?: string;
  usage?: { prompt_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
};
type Group = {
  calls: number;
  chars: number;
  shared: number;
  tokens: number;
  cached: number;
  breaks: Map<string, number>;
};

const groups = new Map<string, Group>();
const recent: { at: number; seen: Seen }[] = [];

for (const line of readFileSync(positionals[0]!, "utf8").split("\n")) {
  if (!line.trim()) {
    continue;
  }

  let rec: Rec;

  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }

  if (!rec.request?.messages) {
    continue;
  }

  const at = Date.parse(rec.time.replace(" ", "T"));

  while (recent.length && at - recent[0]!.at > windowMs) {
    recent.shift();
  }

  const r = reach(
    rec.request,
    recent.map((e) => e.seen),
  );
  const me = seen(rec.request);

  recent.push({ at, seen: me });

  if (values.since && rec.time < values.since) {
    continue;
  }

  const key = `${me.job} | ${rec.provider ?? "provider not logged"}`;
  const g = groups.get(key) ?? {
    calls: 0,
    chars: 0,
    shared: 0,
    tokens: 0,
    cached: 0,
    breaks: new Map(),
  };

  g.calls++;
  g.chars += r.promptChars;
  g.shared += r.sharedChars;
  g.tokens += rec.usage?.prompt_tokens ?? 0;
  g.cached += rec.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const where = `${r.breaksIn} (${r.match ?? "no earlier call"})`;

  g.breaks.set(where, (g.breaks.get(where) ?? 0) + r.promptChars - r.sharedChars);
  groups.set(key, g);
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "-").padStart(4);

console.log(
  `window ${values.window} min. reachable = prefix an ideal cache could serve; cached = what the provider reported.\n`,
);

for (const [key, g] of [...groups].sort((a, b) => b[1].chars - a[1].chars)) {
  console.log(
    `${key}: ${g.calls} calls, ~${approxTokens(g.chars / g.calls)} tok each | reachable ${pct(g.shared, g.chars)}` +
      ` | cached ${g.tokens ? pct(g.cached, g.tokens) : "   -"}`,
  );
  const lost = g.chars - g.shared;

  for (const [where, chars] of [...g.breaks].sort((a, b) => b[1] - a[1]).slice(0, top)) {
    console.log(
      `    ${pct(chars, lost)} of re-read  ~${approxTokens(chars / g.calls)
        .toString()
        .padStart(5)} tok/call  breaks in ${where}`,
    );
  }
}
