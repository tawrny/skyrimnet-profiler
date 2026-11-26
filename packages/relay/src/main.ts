// The relay for any OpenAI-compatible client: no shaping, calls labelled by the profiler's default source.
//
//   node packages/relay/src/main.ts [--listen 8089] [--upstream http://127.0.0.1:8090] [--log calls.jsonl]
//                                   [--sink http://127.0.0.1:8095/api/calls]

import { parseArgs } from "node:util";
import { postCalls, startRelay, toCallInput } from "./index.ts";

const { values: args } = parseArgs({
  options: {
    listen: { type: "string", default: "8089" },
    upstream: { type: "string", default: "http://127.0.0.1:8090" },
    log: { type: "string", default: "calls.jsonl" },
    sink: { type: "string" },
  },
});

const post = args.sink === undefined ? null : postCalls(args.sink);

startRelay({
  listen: Number(args.listen),
  upstream: new URL(args.upstream),
  log: args.log,
  ...(post
    ? {
        sink: (line) => {
          const call = toCallInput(line);

          if (call) {
            post(call);
          }
        },
      }
    : {}),
  describe: post ? `sink ${args.sink}` : "no sink",
});
