// Sends calls to the profiler's ingest endpoint. Fire and forget: the client already has its reply, and a profiler
// that's down or slow must never hold up or break the client. The log file stays the durable copy.

import type { CallInput } from "@volatility/core";

const TIMEOUT_MS = 5000;

export function postCalls(url: string): (call: CallInput) => void {
  let failing = false;

  return (call) => {
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        if (failing) {
          console.log(`sink ${url}: sending again`);
          failing = false;
        }
      })
      .catch((err: unknown) => {
        if (!failing) {
          console.warn(`sink ${url}: ${String(err)}; calls are still logged, import the log later`);
          failing = true;
        }
      });
  };
}
