// The profiler's HTTP API, over any CallStore.
//
//   POST /api/calls                      ingest one CallInput, or an array of them
//   GET  /api/kinds                      kinds of call, with counts
//   GET  /api/calls?kind=&actor=&limit=&offset=   newest first
//   GET  /api/calls/:id                  one call, compared with the previous call of its kind and actor
//   GET  /api/volatility?kind=           each segment's change rates (all kinds when none is given)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  CALL_SORTS,
  compare,
  defaultSource,
  isCallInput,
  previousCall,
  textsNeeded,
  toRecordedCall,
  volatilityReport,
  type CallFilter,
  type CallQuery,
  type CallSort,
  type CallStore,
  type Source,
} from "@volatility/core";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

type HttpError = Error & { status: number };

const httpError = (status: number, message: string): HttpError =>
  Object.assign(new Error(message), { status });

const isHttpError = (err: unknown): err is HttpError =>
  err instanceof Error && "status" in err && typeof err.status === "number";

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];

  for await (const chunk of req) {
    parts.push(Buffer.from(chunk));
  }

  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw httpError(400, "body is not JSON");
  }
}

function filterOf(params: URLSearchParams): CallFilter {
  const kind = params.get("kind");
  const actor = params.get("actor");

  return { ...(kind ? { kind } : {}), ...(actor ? { actor } : {}) };
}

const isCallSort = (s: string): s is CallSort => CALL_SORTS.some((sort) => sort === s);

function share(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);

  if (raw === null) {
    return undefined;
  }

  const n = Number(raw);

  if (raw === "" || !(n >= 0 && n <= 1)) {
    throw httpError(400, `${name} must be a share from 0 to 1`);
  }

  return n;
}

function cachedShareOf(params: URLSearchParams): Pick<CallQuery, "cachedShare"> {
  const atLeast = share(params, "cachedAtLeast");
  const below = share(params, "cachedBelow");

  if (atLeast === undefined && below === undefined) {
    return {};
  }

  return {
    cachedShare: {
      ...(atLeast === undefined ? {} : { atLeast }),
      ...(below === undefined ? {} : { below }),
    },
  };
}

function queryOf(params: URLSearchParams): CallQuery {
  const by = params.get("sort");
  const order = params.get("order") ?? "desc";

  if (by !== null && !isCallSort(by)) {
    throw httpError(400, `sort must be one of ${CALL_SORTS.join(", ")}`);
  }

  if (order !== "asc" && order !== "desc") {
    throw httpError(400, "order must be asc or desc");
  }

  return {
    ...filterOf(params),
    ...cachedShareOf(params),
    ...(by === null ? {} : { sort: { by, descending: order === "desc" } }),
  };
}

function count(params: URLSearchParams, name: string, fallback: number, max: number): number {
  const raw = params.get(name);
  const n = raw === null ? fallback : Number(raw);

  if (!Number.isInteger(n) || n < 0) {
    throw httpError(400, `${name} must be a whole number`);
  }

  return Math.min(n, max);
}

export function apiHandler(store: CallStore, source: Source = defaultSource) {
  const ingest = async (body: unknown) => {
    const inputs = Array.isArray(body) ? body : [body];

    if (!inputs.every(isCallInput)) {
      throw httpError(400, "expected a CallInput or an array of them");
    }

    let created = 0;

    for (const input of inputs) {
      const result = await store.record(toRecordedCall(input, source));

      created += result.created ? 1 : 0;
    }

    return { received: inputs.length, created };
  };

  const callWithComparison = async (id: number) => {
    const call = await store.getCall(id);

    if (call === null) {
      throw httpError(404, `no call ${id}`);
    }

    const rows = await store.callRows({ kind: call.kind });
    const self = rows.find((r) => r.id === id);
    const previous = self ? previousCall(rows, self) : null;

    return {
      call,
      previous: previous && { id: previous.id, ...compare(previous.segments, call.segments) },
    };
  };

  const volatility = async (filter: CallFilter) => {
    const rows = await store.callRows(filter);
    const texts = await store.segmentTexts(textsNeeded(rows));

    return { calls: rows.length, segments: volatilityReport(rows, texts) };
  };

  async function route(req: IncomingMessage, url: URL): Promise<unknown> {
    const path = url.pathname;
    const callId = /^\/api\/calls\/(\d+)$/.exec(path)?.[1];

    if (req.method === "POST" && path === "/api/calls") {
      return ingest(await readJson(req));
    }

    if (req.method !== "GET") {
      throw httpError(405, `${req.method} not allowed`);
    }

    if (path === "/api/kinds") {
      return store.kinds();
    }

    if (path === "/api/calls") {
      const page = {
        limit: count(url.searchParams, "limit", DEFAULT_LIMIT, MAX_LIMIT),
        offset: count(url.searchParams, "offset", 0, Number.MAX_SAFE_INTEGER),
      };

      return store.listCalls(queryOf(url.searchParams), page);
    }

    if (callId !== undefined) {
      return callWithComparison(Number(callId));
    }

    if (path === "/api/volatility") {
      return volatility(filterOf(url.searchParams));
    }

    throw httpError(404, `no route ${path}`);
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    route(req, new URL(req.url ?? "/", "http://localhost"))
      .then((body) => send(res, 200, body))
      .catch((err: unknown) => {
        if (isHttpError(err)) {
          send(res, err.status, { error: err.message });

          return;
        }

        console.error(err);
        send(res, 500, { error: String(err) });
      });
  };
}

export function startApi(port: number, store: CallStore, source?: Source) {
  return createServer(apiHandler(store, source)).listen(port, "127.0.0.1");
}
