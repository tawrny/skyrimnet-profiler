// The relay between SkyrimNet and an OpenAI-compatible server (llama-server locally, or OpenRouter), shaping each
// request as the flags say and labelling calls by SkyrimNet job and speaker.
//
//   node packages/skyrimnet/src/cli/relay.ts [--listen 8089] [--upstream http://127.0.0.1:8090] [--log PATH]
//     [--catalogue-file PATH] [--max-tokens 1024] [--no-no-think] [--trim] [--catalogue off|npc|shared] [--reorder]
//     [--sink http://127.0.0.1:8095/api/calls]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isRecord } from "@volatility/core";
import { postCalls, startRelay, toCallInput } from "@volatility/relay";
import { isShapeable } from "../messages.ts";
import type { CatalogueStore } from "../actions.ts";
import { CATALOGUE_MODES, DEFAULTS, isCatalogueMode, shape } from "../shape.ts";
import { skyrimnetSource } from "../source.ts";

const { values: args } = parseArgs({
  options: {
    listen: { type: "string", default: "8089" },
    upstream: { type: "string", default: "http://127.0.0.1:8090" },
    log: { type: "string", default: "calls-local.jsonl" },
    "catalogue-file": { type: "string", default: "catalogue.json" },
    "max-tokens": { type: "string", default: String(DEFAULTS.maxTokens) },
    "no-no-think": { type: "boolean", default: false },
    trim: { type: "boolean", default: false },
    catalogue: { type: "string", default: DEFAULTS.catalogue },
    reorder: { type: "boolean", default: false },
    sink: { type: "string" },
  },
});

if (!isCatalogueMode(args.catalogue)) {
  throw new Error(`--catalogue must be one of ${CATALOGUE_MODES.join(", ")}`);
}

const opts = {
  ...DEFAULTS,
  maxTokens: Number(args["max-tokens"]),
  noThink: !args["no-no-think"],
  trim: args.trim,
  catalogue: args.catalogue,
  reorder: args.reorder,
};
const cataloguePath = args["catalogue-file"];

function loadCatalogue(): CatalogueStore {
  if (!existsSync(cataloguePath)) {
    return {};
  }

  const parsed: unknown = JSON.parse(readFileSync(cataloguePath, "utf8"));

  if (!isRecord(parsed)) {
    throw new Error(`${cataloguePath} is not a catalogue`);
  }

  const store: CatalogueStore = {};

  for (const [npc, entries] of Object.entries(parsed)) {
    if (isRecord(entries)) {
      store[npc] = Object.fromEntries(
        Object.entries(entries).filter((e): e is [string, string] => typeof e[1] === "string"),
      );
    }
  }

  return store;
}

const catalogue = loadCatalogue();
const post = args.sink === undefined ? null : postCalls(args.sink);
const on = [
  opts.trim && "trim",
  opts.catalogue !== "off" && `catalogue ${opts.catalogue}`,
  opts.reorder && "reorder",
]
  .filter((s) => s)
  .join(", ");

startRelay({
  listen: Number(args.listen),
  upstream: new URL(args.upstream),
  log: args.log,
  shape: (request) => {
    if (!isShapeable(request)) {
      return null;
    }

    const report = shape(request, opts, catalogue);

    if (report.catalogue && (report.catalogue.added.length || report.catalogue.changed.length)) {
      writeFileSync(cataloguePath, JSON.stringify(catalogue, null, 1));
    }

    return report;
  },
  ...(post
    ? {
        sink: (line) => {
          const call = toCallInput(line, skyrimnetSource);

          if (call) {
            post(call);
          }
        },
      }
    : {}),
  describe: `max_tokens ${opts.maxTokens} | no-think ${opts.noThink} | shaping: ${on || "none"} | sink ${args.sink ?? "none"}`,
});
