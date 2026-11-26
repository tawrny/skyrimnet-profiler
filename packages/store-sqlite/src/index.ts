// The CallStore port on SQLite. Segment text is stored once per hash; a call is its row plus an ordered list of
// segment hashes, so the same piece of prompt across thousands of calls costs one row of text.

import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import {
  isRecord,
  type CallFilter,
  type CallQuery,
  type CallRow,
  type CallSort,
  type CallStore,
  type CallSummary,
  type RecordedCall,
  type Segment,
  type StoredCall,
} from "@volatility/core";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  ref TEXT NOT NULL UNIQUE,
  time TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  model TEXT,
  provider TEXT,
  status INTEGER,
  duration_ms REAL,
  first_token_ms REAL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  prompt_tokens INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  reply TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  meta_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_kind_time ON calls (kind, time);
CREATE TABLE IF NOT EXISTS segments (
  hash TEXT PRIMARY KEY,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS call_segments (
  call_id INTEGER NOT NULL REFERENCES calls (id),
  position INTEGER NOT NULL,
  message INTEGER NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  segment_hash TEXT NOT NULL REFERENCES segments (hash),
  template_hash TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (call_id, position)
);
`;

type Row = Record<string, SQLOutputValue>;

function text(row: Row, key: string): string {
  const v = row[key];

  if (typeof v !== "string") {
    throw new Error(`column ${key} is not text`);
  }

  return v;
}

function int(row: Row, key: string): number {
  const v = row[key];

  if (typeof v !== "number") {
    throw new Error(`column ${key} is not a number`);
  }

  return v;
}

const textOrNull = (row: Row, key: string): string | null =>
  row[key] === null ? null : text(row, key);

const numberOrNull = (row: Row, key: string): number | null =>
  row[key] === null ? null : int(row, key);

function jsonObject(row: Row, key: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text(row, key));

  return isRecord(parsed) ? parsed : {};
}

const PREVIEW_CHARS = 200;

const SUMMARY_COLUMNS = `id, time, kind, actor, model, provider, status, duration_ms, first_token_ms, input_tokens,
  cached_input_tokens, output_tokens, cost_usd, prompt_tokens, substr(reply, 1, ${PREVIEW_CHARS}) AS reply_preview`;

function toSummary(row: Row): CallSummary {
  return {
    id: int(row, "id"),
    time: text(row, "time"),
    kind: text(row, "kind"),
    actor: textOrNull(row, "actor"),
    model: textOrNull(row, "model"),
    provider: textOrNull(row, "provider"),
    status: numberOrNull(row, "status"),
    durationMs: numberOrNull(row, "duration_ms"),
    firstTokenMs: numberOrNull(row, "first_token_ms"),
    usage: {
      inputTokens: numberOrNull(row, "input_tokens"),
      cachedInputTokens: numberOrNull(row, "cached_input_tokens"),
      outputTokens: numberOrNull(row, "output_tokens"),
      costUsd: numberOrNull(row, "cost_usd"),
    },
    promptTokens: int(row, "prompt_tokens"),
    replyPreview: text(row, "reply_preview"),
  };
}

type Terms = { terms: string[]; params: SQLInputValue[] };

function filterTerms(filter: CallFilter): Terms {
  const terms: string[] = [];
  const params: SQLInputValue[] = [];

  if (filter.kind !== undefined) {
    terms.push("kind = ?");
    params.push(filter.kind);
  }

  if (filter.actor !== undefined) {
    terms.push("actor = ?");
    params.push(filter.actor);
  }

  return { terms, params };
}

// SQLite gives NULL for a division by zero, so a call with no input tokens has no share, like one with no figures.
const CACHED_SHARE = "(1.0 * cached_input_tokens / input_tokens)";

function queryTerms(query: CallQuery): Terms {
  const { terms, params } = filterTerms(query);

  if (query.cachedShare === undefined) {
    return { terms, params };
  }

  const { atLeast, below } = query.cachedShare;

  terms.push(`${CACHED_SHARE} IS NOT NULL`);

  if (atLeast !== undefined) {
    terms.push(`${CACHED_SHARE} >= ?`);
    params.push(atLeast);
  }

  if (below !== undefined) {
    terms.push(`${CACHED_SHARE} < ?`);
    params.push(below);
  }

  return { terms, params };
}

function where({ terms, params }: Terms): { clause: string; params: SQLInputValue[] } {
  return { clause: terms.length === 0 ? "" : `WHERE ${terms.join(" AND ")}`, params };
}

const SORT_COLUMN: Record<CallSort, string> = {
  time: "time",
  duration: "duration_ms",
  promptTokens: "prompt_tokens",
  cachedShare: CACHED_SHARE,
  cost: "cost_usd",
};

function orderBy(query: CallQuery): string {
  const { by, descending } = query.sort ?? { by: "time", descending: true };
  const direction = descending ? "DESC" : "ASC";

  return `ORDER BY ${SORT_COLUMN[by]} ${direction} NULLS LAST, id ${direction}`;
}

export function openSqliteStore(path: string): CallStore {
  const db = new DatabaseSync(path);

  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const insertCall = db.prepare(`
    INSERT INTO calls (ref, time, kind, actor, model, provider, status, duration_ms, first_token_ms, input_tokens,
      cached_input_tokens, output_tokens, cost_usd, prompt_tokens, params_json, reply, reasoning, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ref) DO NOTHING
    RETURNING id`);
  const callByRef = db.prepare("SELECT id FROM calls WHERE ref = ?");
  const insertSegment = db.prepare(
    "INSERT INTO segments (hash, text) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING",
  );
  const insertCallSegment = db.prepare(`
    INSERT INTO call_segments (call_id, position, message, role, name, segment_hash, template_hash, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const callById = db.prepare("SELECT * FROM calls WHERE id = ?");
  const segmentsOf = db.prepare(`
    SELECT cs.*, s.text FROM call_segments cs JOIN segments s ON s.hash = cs.segment_hash
    WHERE cs.call_id = ? ORDER BY cs.position`);

  const record = (call: RecordedCall) => {
    db.exec("BEGIN");

    try {
      const promptTokens = call.segments.reduce((sum, s) => sum + s.tokens, 0);
      const inserted = insertCall.get(
        call.ref,
        call.time,
        call.kind,
        call.actor,
        call.model,
        call.provider,
        call.status,
        call.durationMs,
        call.firstTokenMs,
        call.usage.inputTokens,
        call.usage.cachedInputTokens,
        call.usage.outputTokens,
        call.usage.costUsd,
        promptTokens,
        JSON.stringify(call.params),
        call.reply,
        call.reasoning,
        JSON.stringify(call.meta),
      );

      if (inserted === undefined) {
        db.exec("COMMIT");
        const existing = callByRef.get(call.ref);

        if (existing === undefined) {
          throw new Error(`call ${call.ref} conflicted but isn't stored`);
        }

        return { id: int(existing, "id"), created: false };
      }

      const id = int(inserted, "id");

      for (const s of call.segments) {
        insertSegment.run(s.hash, s.text);
        insertCallSegment.run(
          id,
          s.position,
          s.message,
          s.role,
          s.name,
          s.hash,
          s.templateHash,
          s.tokens,
        );
      }

      db.exec("COMMIT");

      return { id, created: true };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  const toSegment = (row: Row): Segment => ({
    position: int(row, "position"),
    message: int(row, "message"),
    role: text(row, "role"),
    name: text(row, "name"),
    text: text(row, "text"),
    hash: text(row, "segment_hash"),
    templateHash: text(row, "template_hash"),
    tokens: int(row, "tokens"),
  });

  const getCall = (id: number): StoredCall | null => {
    const row = callById.get(id);

    if (row === undefined) {
      return null;
    }

    return {
      ...toSummary({ ...row, reply_preview: text(row, "reply").slice(0, PREVIEW_CHARS) }),
      params: jsonObject(row, "params_json"),
      segments: segmentsOf.all(id).map(toSegment),
      reply: text(row, "reply"),
      reasoning: text(row, "reasoning"),
      meta: jsonObject(row, "meta_json"),
    };
  };

  const callRows = (filter: CallFilter): CallRow[] => {
    const { clause, params } = where(filterTerms(filter));
    const calls = new Map<number, CallRow>();

    for (const row of db
      .prepare(`SELECT id, time, kind, actor FROM calls ${clause} ORDER BY time, id`)
      .all(...params)) {
      const id = int(row, "id");

      calls.set(id, {
        id,
        time: text(row, "time"),
        kind: text(row, "kind"),
        actor: textOrNull(row, "actor"),
        segments: [],
      });
    }

    const segmentRows = db
      .prepare(
        `SELECT cs.call_id, cs.position, cs.name, cs.segment_hash, cs.template_hash, cs.tokens
         FROM call_segments cs JOIN calls ON calls.id = cs.call_id ${clause} ORDER BY cs.call_id, cs.position`,
      )
      .all(...params);

    for (const row of segmentRows) {
      calls.get(int(row, "call_id"))?.segments.push({
        position: int(row, "position"),
        name: text(row, "name"),
        hash: text(row, "segment_hash"),
        templateHash: text(row, "template_hash"),
        tokens: int(row, "tokens"),
      });
    }

    return [...calls.values()];
  };

  const textsByHash = db.prepare(
    "SELECT hash, text FROM segments WHERE hash IN (SELECT value FROM json_each(?))",
  );

  const segmentTexts = (hashes: readonly string[]): Map<string, string> =>
    new Map(
      textsByHash.all(JSON.stringify(hashes)).map((row) => [text(row, "hash"), text(row, "text")]),
    );

  return {
    record: async (call) => record(call),
    listCalls: async (query, page) => {
      const { clause, params } = where(queryTerms(query));
      const total = db.prepare(`SELECT count(*) AS n FROM calls ${clause}`).get(...params);
      const rows = db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM calls ${clause} ${orderBy(query)} LIMIT ? OFFSET ?`,
        )
        .all(...params, page.limit, page.offset);

      return { total: total === undefined ? 0 : int(total, "n"), calls: rows.map(toSummary) };
    },
    getCall: async (id) => getCall(id),
    kinds: async () =>
      db
        .prepare("SELECT kind, count(*) AS calls FROM calls GROUP BY kind ORDER BY calls DESC")
        .all()
        .map((row) => ({ kind: text(row, "kind"), calls: int(row, "calls") })),
    callRows: async (filter) => callRows(filter),
    segmentTexts: async (hashes) => segmentTexts(hashes),
    close: async () => db.close(),
  };
}
