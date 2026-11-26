// Logging relay between SkyrimNet and an OpenAI-compatible server: llama-server locally, or OpenRouter.
//
// SkyrimNet only logs prompts and replies for its OpenRouter provider. This relay listens where SkyrimNet sends
// requests, shapes each chat request (see prompt/shape.ts), forwards it, streams the reply back as it
// arrives, and appends one JSON line per call to a log. A second, read-only port serves that log to the viewer.
//
//   node src/server.ts [--listen 8089] [--upstream http://127.0.0.1:8090] [--log PATH] [--catalogue-file PATH]
//                      [--api 8091] [--max-tokens 1024] [--no-no-think] [--trim] [--catalogue] [--reorder]

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { DEFAULTS, shape, type CatalogueStore, type ChatRequest, type ShapeReport } from "./prompt/index.ts";
import { startApi } from "./api.ts";

const { values: args } = parseArgs({
  options: {
    listen: { type: "string", default: "8089" },
    upstream: { type: "string", default: "http://127.0.0.1:8090" },
    log: { type: "string", default: "calls-local.jsonl" },
    "catalogue-file": { type: "string", default: "catalogue.json" },
    api: { type: "string", default: "8091" },
    "max-tokens": { type: "string", default: String(DEFAULTS.maxTokens) },
    "no-no-think": { type: "boolean", default: false },
    trim: { type: "boolean", default: false },
    catalogue: { type: "boolean", default: false },
    reorder: { type: "boolean", default: false },
  },
});

const opts = {
  ...DEFAULTS,
  maxTokens: Number(args["max-tokens"]),
  noThink: !args["no-no-think"],
  trim: args.trim!,
  catalogue: args.catalogue!,
  reorder: args.reorder!,
};
const upstream = new URL(args.upstream!);
const sendUpstream = upstream.protocol === "https:" ? httpsRequest : httpRequest;
const logPath = args.log!;
const cataloguePath = args["catalogue-file"]!;
const store: CatalogueStore = existsSync(cataloguePath) ? JSON.parse(readFileSync(cataloguePath, "utf8")) : {};

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade",
  "proxy-authorization", "proxy-authenticate", "content-length", "host",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

/** llama-server's own split of a call: prompt tokens read (and reused from cache), tokens generated, time for each. */
interface Timings {
  cache_n?: number;
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
}

/** The assistant text, reasoning and llama-server timings from a JSON or SSE reply body. */
function replyText(body: string, streamed: boolean): { reply: string; reasoning: string; timings: Timings | null } {
  const content: string[] = [];
  const reasoning: string[] = [];
  let timings: Timings | null = null;
  try {
    if (streamed) {
      for (const raw of body.split("\n")) {
        const line = raw.trim();
        if (!line.startsWith("data:") || line.slice(5).trim() === "[DONE]") continue;
        const chunk = JSON.parse(line.slice(5).trim());
        timings = chunk.timings ?? timings;
        for (const ch of chunk.choices ?? []) {
          content.push(ch.delta?.content ?? "");
          reasoning.push(ch.delta?.reasoning_content ?? "");
        }
      }
    } else {
      const parsed = JSON.parse(body);
      timings = parsed.timings ?? null;
      for (const ch of parsed.choices ?? []) {
        content.push(ch.message?.content ?? "");
        reasoning.push(ch.message?.reasoning_content ?? "");
      }
    }
  } catch {
    return { reply: body.slice(0, 2000), reasoning: "", timings };
  }
  return { reply: content.join(""), reasoning: reasoning.join(""), timings };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = await readBody(req);
  const isChat = req.method === "POST" && (req.url ?? "").endsWith("/chat/completions");
  let shaped: ChatRequest | null = null;
  let report: ShapeReport | null = null;
  if (isChat && body.length) {
    try {
      shaped = JSON.parse(body.toString("utf8")) as ChatRequest;
      report = shape(shaped, opts, store);
      if (report.catalogue && (report.catalogue.added.length || report.catalogue.changed.length)) {
        writeFileSync(cataloguePath, JSON.stringify(store, null, 1));
      }
      body = Buffer.from(JSON.stringify(shaped), "utf8");
    } catch {
      shaped = null; // not JSON: forward untouched
    }
  }
  const t0 = performance.now();
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }
  // The reply is logged as text, so ask the upstream for it uncompressed; SkyrimNet's hop is local anyway.
  delete headers["accept-encoding"]; // Node lowercases incoming header names
  headers["content-length"] = String(body.length);

  // SkyrimNet abandons a call that is slow to its first token and retries it; cancel ours so llama-server
  // stops generating a reply nobody reads, which would hold a slot the retry needs.
  let clientGone = false;
  let firstByteMs: number | null = null; // what SkyrimNet's first-token deadline measures
  res.on("close", () => {
    if (res.writableFinished) return;
    clientGone = true;
    up.destroy();
  });

  const up = sendUpstream(
    { hostname: upstream.hostname, port: upstream.port || undefined, path: req.url, method: req.method, headers, timeout: 600_000 },
    (upRes) => {
      const outHeaders: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) outHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders); // no content-length: Node streams it chunked
      const captured: Buffer[] = [];
      upRes.on("data", (c: Buffer) => {
        firstByteMs ??= performance.now() - t0;
        captured.push(c);
        if (!clientGone) res.write(c);
      });
      upRes.on("end", () => {
        if (!clientGone) res.end();
      });
      // "close" follows both a finished reply and one cut short by the client hanging up.
      upRes.on("close", () => record(upRes.statusCode ?? null, upRes.headers["content-type"] ?? "", captured));
    },
  );
  up.on("error", (err) => {
    if (clientGone) {
      record(null, "", []); // hung up before llama-server started replying
      return;
    }
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `relay: upstream ${upstream.origin} failed: ${err.message}` } }));
  });
  up.end(body);

  let recorded = false;
  function record(status: number | null, contentType: string, captured: Buffer[]) {
    if (recorded || !isChat) return;
    recorded = true;
    const { reply, reasoning, timings } = replyText(Buffer.concat(captured).toString("utf8"), contentType.includes("text/event-stream"));
    const rec = {
      time: stamp(),
      status,
      client_gave_up: clientGone,
      asked_max_tokens: report?.askedMaxTokens ?? null,
      seconds: Math.round((performance.now() - t0) / 10) / 100,
      first_byte_ms: firstByteMs === null ? null : Math.round(firstByteMs),
      timings,
      shaping: report,
      request: shaped ?? { raw: body.subarray(0, 2000).toString("utf8") },
      reply,
      reasoning,
    };
    appendFileSync(logPath, JSON.stringify(rec) + "\n");
  }
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `relay: ${String(err)}` } }));
  });
}).listen(Number(args.listen), "127.0.0.1", () => {
  const on = (["trim", "catalogue", "reorder"] as const).filter((k) => opts[k]).join(", ") || "none";
  console.log(`relay 127.0.0.1:${args.listen} -> ${upstream.origin} | log ${logPath} | max_tokens ${opts.maxTokens} | no-think ${opts.noThink} | shaping: ${on}`);
});

startApi(Number(args.api), logPath, store);
