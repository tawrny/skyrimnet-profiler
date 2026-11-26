// Read-only HTTP API over the relay's call log, for the viewer.
//
//   GET /api/calls?offset=&limit=   newest first: summaries (time, job, npc, size, seconds, thinking, preview)
//   GET /api/calls/:index           one call: request, reply, reasoning, anatomy, and the prefix it shares with
//                                   the same NPC's previous call (what the model server could reuse)
//   GET /api/volatility?last=N      section change rates over the last N calls
//   GET /api/catalogue              the action catalogue (per NPC, or shared)

import { createServer, type ServerResponse } from "node:http";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import {
  anatomy,
  approxTokens,
  classify,
  promptText,
  sharedPrefix,
  speaker,
  volatility,
  type CatalogueStore,
  type ChatRequest,
} from "@volatility/skyrimnet";

type Rec = {
  time: string;
  status?: number;
  seconds: number;
  request: ChatRequest;
  reply: string;
  reasoning?: string;
  client_gave_up?: boolean;
  shaping?: unknown;
};

/** The log, parsed incrementally: only bytes appended since the last read are parsed. */
class Log {
  records: Rec[] = [];
  private offset = 0;
  private rest = "";
  private path: string;
  constructor(path: string) {
    this.path = path;
  }

  refresh(): void {
    if (!existsSync(this.path)) {
      return;
    }

    const size = statSync(this.path).size;

    if (size < this.offset) {
      this.records = [];
      this.offset = 0;
      this.rest = "";
    } // log was replaced

    if (size === this.offset) {
      return;
    }

    const fd = openSync(this.path, "r");
    const buf = Buffer.alloc(size - this.offset);

    readSync(fd, buf, 0, buf.length, this.offset);
    closeSync(fd);
    this.offset = size;
    const lines = (this.rest + buf.toString("utf8")).split("\n");

    this.rest = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      try {
        this.records.push(JSON.parse(line) as Rec);
      } catch {
        // a torn or non-JSON line: skip it
      }
    }
  }
}

function summary(r: Rec, index: number) {
  const req = r.request ?? {};
  const job = classify(req);
  const text = promptText(req);

  return {
    index,
    time: r.time,
    seconds: r.seconds,
    status: r.status,
    job: job.id,
    jobLabel: job.label,
    npc: speaker(req),
    promptTokens: approxTokens(text.length),
    thinking:
      (req.chat_template_kwargs as { enable_thinking?: boolean } | undefined)?.enable_thinking !==
      false,
    gaveUp: !!r.client_gave_up,
    reply: (r.reply ?? "").slice(0, 160),
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

export function startApi(port: number, logPath: string, store: CatalogueStore): void {
  const log = new Log(logPath);

  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    try {
      log.refresh();
      const recs = log.records;

      if (url.pathname === "/api/calls") {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 2000);
        const out = [];

        for (let i = recs.length - 1 - offset; i >= 0 && out.length < limit; i--) {
          out.push(summary(recs[i]!, i));
        }

        return send(res, 200, { total: recs.length, calls: out });
      }

      const one = /^\/api\/calls\/(\d+)$/.exec(url.pathname);

      if (one) {
        const i = Number(one[1]);
        const r = recs[i];

        if (!r) {
          return send(res, 404, { error: "no such call" });
        }

        const npc = speaker(r.request);
        const job = classify(r.request).id;
        let prevIndex: number | null = null;

        for (let j = i - 1; j >= 0 && npc; j--) {
          const p = recs[j]!;

          if (speaker(p.request) === npc && classify(p.request).id === job) {
            prevIndex = j;
            break;
          }
        }

        const text = promptText(r.request);
        const shared =
          prevIndex === null ? 0 : sharedPrefix(text, promptText(recs[prevIndex]!.request));

        return send(res, 200, {
          ...summary(r, i),
          request: r.request,
          replyFull: r.reply,
          reasoning: r.reasoning ?? "",
          shaping: r.shaping ?? null,
          anatomy: anatomy(r.request),
          promptChars: text.length,
          previousIndex: prevIndex,
          sharedChars: shared,
        });
      }

      if (url.pathname === "/api/volatility") {
        const last = Number(url.searchParams.get("last") ?? 2000);

        return send(res, 200, volatility(recs.slice(-last).map((r) => r.request)));
      }

      if (url.pathname === "/api/catalogue") {
        return send(res, 200, store);
      }

      return send(res, 404, { error: "unknown endpoint" });
    } catch (err) {
      return send(res, 500, { error: String(err) });
    }
  }).listen(port, "127.0.0.1", () => console.log(`viewer API http://127.0.0.1:${port}/api/calls`));
}
