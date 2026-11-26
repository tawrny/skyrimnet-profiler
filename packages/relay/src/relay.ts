// A logging relay in front of an OpenAI-compatible server. It listens where the client sends requests, optionally
// shapes each chat request, forwards it, streams the reply back as it arrives, then appends one JSON line per call to
// a log and hands the line to a sink (the profiler's ingest endpoint, say).

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { appendFileSync } from "node:fs";
import { isChatRequest, type ChatRequest } from "@volatility/core";
import { replyText, type LogRecord } from "./record.ts";

export type RelayOptions = {
  listen: number;
  upstream: URL;
  log: string;
  /** Changes a chat request in place before it's forwarded; what it returns is logged as the call's shaping. */
  shape?: (request: ChatRequest) => unknown;
  sink?: (record: LogRecord) => void;
  /** Extra words for the start-up line, such as which shapers are on. */
  describe?: string;
};

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "content-length",
  "host",
]);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];

    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

const stamp = () => {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");

  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

function parseChat(body: Buffer): ChatRequest | null {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));

    return isChatRequest(parsed) ? parsed : null;
  } catch {
    return null; // not JSON: forward untouched
  }
}

export function startRelay(options: RelayOptions) {
  const { upstream } = options;
  const sendUpstream = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = await readBody(req);
    const isChat = req.method === "POST" && (req.url ?? "").endsWith("/chat/completions");
    let request = isChat && body.length ? parseChat(body) : null;
    const askedMaxTokens = typeof request?.max_tokens === "number" ? request.max_tokens : null;
    let shaping: unknown = null;

    if (request && options.shape) {
      const shaped = structuredClone(request);

      try {
        shaping = options.shape(shaped);
        request = shaped;
        body = Buffer.from(JSON.stringify(shaped), "utf8");
      } catch (err) {
        console.warn(`relay: shaping failed, forwarding the request as sent: ${String(err)}`);
      }
    }

    const t0 = performance.now();
    const headers: Record<string, string> = {};

    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && typeof v === "string") {
        headers[k] = v;
      }
    }

    // The reply is logged as text, so ask the upstream for it uncompressed; the client's hop is local anyway.
    delete headers["accept-encoding"]; // Node lowercases incoming header names
    headers["content-length"] = String(body.length);

    // A client may abandon a call that is slow to its first token and retry it; cancel ours so the server stops
    // generating a reply nobody reads, which would hold a slot the retry needs.
    let clientGone = false;
    let firstByteMs: number | null = null;

    res.on("close", () => {
      if (res.writableFinished) {
        return;
      }

      clientGone = true;
      up.destroy();
    });

    const up = sendUpstream(
      {
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        path: req.url,
        method: req.method,
        headers,
        timeout: 600_000,
      },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};

        for (const [k, v] of Object.entries(upRes.headers)) {
          if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) {
            outHeaders[k] = v;
          }
        }

        res.writeHead(upRes.statusCode ?? 502, outHeaders); // no content-length: Node streams it chunked
        const captured: Buffer[] = [];

        upRes.on("data", (c: Buffer) => {
          firstByteMs ??= performance.now() - t0;
          captured.push(c);

          if (!clientGone) {
            res.write(c);
          }
        });
        upRes.on("end", () => {
          if (!clientGone) {
            res.end();
          }
        });
        // "close" follows both a finished reply and one cut short by the client hanging up.
        upRes.on("close", () =>
          record(upRes.statusCode ?? null, upRes.headers["content-type"] ?? "", captured),
        );
      },
    );

    up.on("error", (err) => {
      if (clientGone) {
        record(null, "", []); // hung up before the server started replying

        return;
      }

      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }

      res.end(
        JSON.stringify({
          error: { message: `relay: upstream ${upstream.origin} failed: ${err.message}` },
        }),
      );
    });
    up.end(body);

    let recorded = false;

    function record(status: number | null, contentType: string, captured: Buffer[]) {
      if (recorded || !isChat) {
        return;
      }

      recorded = true;
      const parts = replyText(
        Buffer.concat(captured).toString("utf8"),
        contentType.includes("text/event-stream"),
      );
      const line: LogRecord = {
        time: stamp(),
        status,
        client_gave_up: clientGone,
        asked_max_tokens: askedMaxTokens,
        seconds: Math.round((performance.now() - t0) / 10) / 100,
        first_byte_ms: firstByteMs === null ? null : Math.round(firstByteMs),
        timings: parts.timings,
        provider: parts.provider,
        usage: parts.usage,
        shaping,
        request: request ?? { raw: body.subarray(0, 2000).toString("utf8") },
        reply: parts.reply,
        reasoning: parts.reasoning,
      };

      appendFileSync(options.log, JSON.stringify(line) + "\n");

      try {
        options.sink?.(line);
      } catch (err) {
        console.warn(`relay: sink failed: ${String(err)}`);
      }
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }

      res.end(JSON.stringify({ error: { message: `relay: ${String(err)}` } }));
    });
  }).listen(options.listen, "127.0.0.1", () => {
    const extra = options.describe ? ` | ${options.describe}` : "";

    console.log(
      `relay 127.0.0.1:${options.listen} -> ${upstream.origin} | log ${options.log}${extra}`,
    );
  });
}
