// Load a relay log into the profiler, through its ingest endpoint. Safe to repeat: calls already stored are skipped.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { CallInput, ChatRequest, Labels } from "@volatility/core";
import { toCallInput } from "./record.ts";

const BATCH = 100;

/** `torn` counts lines that aren't JSON, such as one cut short when the relay was killed mid-write. */
export type ImportResult = { lines: number; torn: number; calls: number; created: number };

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function post(url: string, calls: CallInput[]): Promise<number> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls),
  });

  if (!res.ok) {
    throw new Error(`${url}: HTTP ${res.status} ${await res.text()}`);
  }

  const body: unknown = await res.json();

  return typeof body === "object" &&
    body !== null &&
    "created" in body &&
    typeof body.created === "number"
    ? body.created
    : 0;
}

export async function importLog(
  path: string,
  url: string,
  label?: (request: ChatRequest) => Labels,
): Promise<ImportResult> {
  const result: ImportResult = { lines: 0, torn: 0, calls: 0, created: 0 };
  let batch: CallInput[] = [];

  for await (const line of createInterface({
    input: createReadStream(path, "utf8"),
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) {
      continue;
    }

    result.lines++;
    const parsed = parseLine(line);

    if (parsed === null) {
      result.torn++;
      continue;
    }

    const call = toCallInput(parsed, label);

    if (call) {
      batch.push(call);
    }

    if (batch.length === BATCH) {
      result.created += await post(url, batch);
      result.calls += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    result.created += await post(url, batch);
    result.calls += batch.length;
  }

  return result;
}
