import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { importLog, replyText, startRelay, toCallInput, type LogRecord } from "../src/index.ts";

// replyText

const JSON_REPLY = JSON.stringify({
  choices: [{ message: { content: "Aye.", reasoning_content: "hm" } }],
  usage: { prompt_tokens: 10 },
  provider: "DeepInfra",
});
const SSE_REPLY = [
  'data: {"choices":[{"delta":{"content":"A"}}]}',
  'data: {"choices":[{"delta":{"content":"ye."}}],"usage":{"prompt_tokens":10},"provider":"DeepInfra"}',
  "data: [DONE]",
].join("\n");
const NOT_JSON = "upstream fell over";

const replyCases: [string, string, boolean, string, string | null][] = [
  ["a JSON reply", JSON_REPLY, false, "Aye.", "DeepInfra"],
  ["an SSE stream", SSE_REPLY, true, "Aye.", "DeepInfra"],
  ["a body that isn't JSON", NOT_JSON, false, NOT_JSON, null],
];

describe("replyText", () => {
  for (const [name, body, streamed, reply, provider] of replyCases) {
    it(`reads ${name}`, () => {
      const parts = replyText(body, streamed);

      assert.deepEqual([parts.reply, parts.provider], [reply, provider]);
    });
  }
});

// toCallInput

const REQUEST = { model: "m", messages: [{ role: "system", content: "You are Lydia, a Nord." }] };

const line = (extra: Partial<LogRecord>): LogRecord => ({
  time: "2026-11-27 10:00:00.123",
  status: 200,
  client_gave_up: false,
  asked_max_tokens: null,
  seconds: 1.25,
  first_byte_ms: 300,
  timings: null,
  provider: null,
  usage: null,
  shaping: null,
  request: REQUEST,
  reply: "Aye.",
  reasoning: "",
  ...extra,
});

const OPENROUTER = line({
  usage: {
    prompt_tokens: 100,
    prompt_tokens_details: { cached_tokens: 80 },
    completion_tokens: 5,
    cost: 0.001,
  },
});
const LLAMA = line({ timings: { cache_n: 80, prompt_n: 20, predicted_n: 5 } });
const RAW = line({ request: { raw: "not json" } });

const OPENROUTER_USAGE = {
  inputTokens: 100,
  cachedInputTokens: 80,
  outputTokens: 5,
  costUsd: 0.001,
};
const LLAMA_USAGE = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 5, costUsd: null };

describe("toCallInput", () => {
  it("reads usage from the provider's report", () => {
    assert.deepEqual(toCallInput(OPENROUTER)?.usage, OPENROUTER_USAGE);
  });

  it("reads usage from llama-server's timings when there's no report, counting cached tokens as input", () => {
    assert.deepEqual(toCallInput(LLAMA)?.usage, LLAMA_USAGE);
  });

  it("converts seconds and the local time stamp", () => {
    const call = toCallInput(OPENROUTER);

    assert.deepEqual(
      [call?.durationMs, call?.time],
      [1250, new Date("2026-11-27 10:00:00.123").toISOString()],
    );
  });

  it("skips a call whose body wasn't a chat request", () => {
    assert.equal(toCallInput(RAW), null);
  });
});

// startRelay

const CHAT = JSON.stringify({
  model: "m",
  max_tokens: 50,
  messages: [{ role: "user", content: "Hi" }],
});

const dir = mkdtempSync(join(tmpdir(), "relay-test-"));
const servers: Server[] = [];

const port = (server: Server) => {
  const address = server.address();

  return typeof address === "object" && address !== null ? (address satisfies AddressInfo).port : 0;
};

const received: unknown[] = [];
const upstream = createServer((req, res) => {
  const parts: Buffer[] = [];

  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => {
    received.push(JSON.parse(Buffer.concat(parts).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON_REPLY);
  });
}).listen(0, "127.0.0.1");

servers.push(upstream);
await once(upstream, "listening");

async function relayWith(shape: (request: Record<string, unknown>) => unknown) {
  const log = join(dir, `${servers.length}.jsonl`);
  const sunk: LogRecord[] = [];
  const relay = startRelay({
    listen: 0,
    upstream: new URL(`http://127.0.0.1:${port(upstream)}`),
    log,
    shape,
    sink: (record) => sunk.push(record),
  });

  servers.push(relay);
  await once(relay, "listening");
  received.length = 0;
  const res = await fetch(`http://127.0.0.1:${port(relay)}/v1/chat/completions`, {
    method: "POST",
    body: CHAT,
  });
  const body = await res.text();

  await new Promise((resolve) => setTimeout(resolve, 50)); // the log line follows the reply's close

  return { status: res.status, body, logged: readFileSync(log, "utf8").trim().split("\n"), sunk };
}

after(() => servers.forEach((s) => s.close()));

const shortenReply = (request: Record<string, unknown>) => {
  request.max_tokens = 10;

  return { shortened: true };
};

const brokenShaper = (request: Record<string, unknown>) => {
  request.max_tokens = 10;
  throw new Error("shaper bug");
};

describe("startRelay", () => {
  it("forwards the shaped request, returns the reply, and logs and sinks the call with its shaping", async () => {
    const { status, body, logged, sunk } = await relayWith(shortenReply);

    assert.deepEqual(
      [status, body, received[0]],
      [200, JSON_REPLY, { ...JSON.parse(CHAT), max_tokens: 10 }],
    );
    assert.equal(logged.length, 1);
    assert.deepEqual(
      [sunk[0]?.shaping, sunk[0]?.asked_max_tokens, sunk[0]?.reply],
      [{ shortened: true }, 50, "Aye."],
    );
  });

  it("forwards and logs the request as sent when shaping throws", async () => {
    const { status, body, sunk } = await relayWith(brokenShaper);

    assert.deepEqual(
      [status, body, received[0], sunk[0]?.request],
      [200, JSON_REPLY, JSON.parse(CHAT), JSON.parse(CHAT)],
    );
  });
});

// importLog

const TORN = `{"time": "2026-11-27 10:0${"\u0000".repeat(4)}`;
const LOG_LINES = [JSON.stringify(OPENROUTER), TORN, JSON.stringify(RAW), ""];

const ingested: unknown[] = [];
const ingest = createServer((req, res) => {
  const parts: Buffer[] = [];

  req.on("data", (c: Buffer) => parts.push(c));
  req.on("end", () => {
    const calls: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));

    ingested.push(calls);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ created: Array.isArray(calls) ? calls.length : 0 }));
  });
}).listen(0, "127.0.0.1");

servers.push(ingest);
await once(ingest, "listening");

describe("importLog", () => {
  it("posts each chat call, counting a torn line and skipping one that wasn't a chat request", async () => {
    const log = join(dir, "import.jsonl");

    writeFileSync(log, LOG_LINES.join("\n"));
    const result = await importLog(log, `http://127.0.0.1:${port(ingest)}/api/calls`);

    assert.deepEqual(result, { lines: 3, torn: 1, calls: 1, created: 1 });
    assert.deepEqual(ingested, [[toCallInput(OPENROUTER)]]);
  });
});
