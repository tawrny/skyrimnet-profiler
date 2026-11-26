// Load SkyrimNet relay logs into the profiler, labelled by job and speaker. Safe to repeat.
//
//   node packages/skyrimnet/src/cli/import.ts LOG... [--api http://127.0.0.1:8095/api/calls]

import { parseArgs } from "node:util";
import { importLog } from "@volatility/relay";
import { skyrimnetSource } from "../source.ts";

const { values: args, positionals: logs } = parseArgs({
  allowPositionals: true,
  options: { api: { type: "string", default: "http://127.0.0.1:8095/api/calls" } },
});

for (const log of logs) {
  const { lines, torn, calls, created } = await importLog(log, args.api, skyrimnetSource);

  console.log(`${log}: ${lines} lines (${torn} torn), ${calls} calls, ${created} new`);
}
