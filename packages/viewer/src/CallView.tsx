import { useEffect, useState } from "react";
import { api, type CallDetail, type SegmentStatus } from "./api.ts";

const STATUS_LABEL: Record<SegmentStatus | "first", string> = {
  same: "Same as the previous call",
  changed: "Changed",
  new: "New in this call",
  first: "No previous call to compare",
};

const fmt = (n: number) => n.toLocaleString();

/** Segments narrower than this share of the track are too thin to label; their name is in the tooltip. */
const MIN_LABELLED_SHARE = 0.03;

export function CallView({ id, onOpen }: { id: number; onOpen: (id: number) => void }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    api.call(id).then(setDetail, (e: unknown) => setError(String(e)));
  }, [id]);

  if (error) {
    return <p className="err">{error}</p>;
  }

  if (!detail) {
    return <p className="hint">Loading…</p>;
  }

  const { call, previous } = detail;
  const status = (i: number): SegmentStatus | "first" => previous?.statuses[i] ?? "first";
  const shown = new Set(call.segments.map((_, i) => status(i)));
  const pct = (n: number) => `${(100 * n) / Math.max(1, call.promptTokens)}%`;
  const { usage } = call;

  return (
    <div className="detail">
      <h2>
        {call.kind}
        {call.actor && <> · {call.actor}</>}{" "}
        <small>
          #{call.id} · {new Date(call.time).toLocaleString()}
          {call.durationMs !== null && <> · {(call.durationMs / 1000).toFixed(1)} s</>}
          {call.model && <> · {call.model}</>}
          {call.provider && <> via {call.provider}</>}
        </small>
      </h2>

      <h3>
        Segments <small>{fmt(call.promptTokens)} tok (approx.)</small>
      </h3>
      <div className="anatomy">
        <div className="track">
          {call.segments.map((s, i) => (
            <span
              key={i}
              className={`seg st-${status(i)}`}
              style={{ width: pct(s.tokens) }}
              title={`${s.name}: ${fmt(s.tokens)} tok, ${STATUS_LABEL[status(i)].toLowerCase()}`}
            >
              {s.tokens / Math.max(1, call.promptTokens) >= MIN_LABELLED_SHARE &&
                s.name.split(" › ").at(-1)}
            </span>
          ))}
          {previous && previous.stablePrefixTokens > 0 && (
            <span className="reused" style={{ width: pct(previous.stablePrefixTokens) }} />
          )}
        </div>
        <div className="legend">
          {[...shown].map((st) => (
            <span key={st}>
              <i className={`st-${st}`} />
              {STATUS_LABEL[st]}
            </span>
          ))}
          {previous && (
            <span>
              <i className="reused-key" />
              Stable prefix
            </span>
          )}
        </div>
      </div>

      {previous ? (
        <p className="cache">
          Against the previous call of this kind and actor (
          <a onClick={() => onOpen(previous.id)}>#{previous.id}</a>):{" "}
          <b>{fmt(previous.stablePrefixTokens)} tok</b> unchanged from the start, which a prefix
          cache could reuse (
          {Math.round((100 * previous.stablePrefixTokens) / Math.max(1, call.promptTokens))}%).
        </p>
      ) : (
        <p className="cache">No earlier call of this kind and actor.</p>
      )}

      {usage.inputTokens !== null && (
        <p className="hint">
          Provider reported {fmt(usage.inputTokens)} input tok
          {usage.cachedInputTokens !== null && <>, {fmt(usage.cachedInputTokens)} cached</>}
          {usage.outputTokens !== null && <>, {fmt(usage.outputTokens)} output</>}
          {usage.costUsd !== null && <>, ${usage.costUsd.toFixed(5)}</>}.
        </p>
      )}

      <table className="spans">
        <thead>
          <tr>
            <th></th>
            <th>Segment</th>
            <th>Role</th>
            <th className="num">Tok</th>
          </tr>
        </thead>
        <tbody>
          {call.segments.map((s, i) => (
            <tr key={i}>
              <td>
                <i className={`st-${status(i)}`} title={STATUS_LABEL[status(i)]} />
              </td>
              <td>
                <details>
                  <summary>{s.name}</summary>
                  <pre>{s.text}</pre>
                </details>
              </td>
              <td>{s.role}</td>
              <td className="num">{fmt(s.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Reply</h3>
      <pre className="reply">{call.reply || "(empty)"}</pre>
      {call.reasoning && (
        <details>
          <summary>Reasoning ({fmt(call.reasoning.length)} chars)</summary>
          <pre>{call.reasoning}</pre>
        </details>
      )}
      <details>
        <summary>Parameters and metadata</summary>
        <pre>{JSON.stringify({ params: call.params, meta: call.meta }, null, 1)}</pre>
      </details>
    </div>
  );
}
