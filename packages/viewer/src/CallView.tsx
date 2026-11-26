import { useEffect, useState } from "react";
import type { Span, SpanKind } from "@skyrimnet/relay/prompt";
import { api, type CallDetail } from "./api.ts";

const KIND_LABEL: Record<SpanKind, string> = {
  system: "System (bio, rules)",
  catalogue: "Action catalogue",
  history: "History",
  stable: "Stable context",
  volatile: "Volatile context",
  task: "Task",
  actions: "Action list",
  other: "Other",
};
const tok = (chars: number) => Math.round(chars / 4).toLocaleString();

function AnatomyBar({ spans, total, shared }: { spans: Span[]; total: number; shared: number }) {
  const pct = (n: number) => `${(100 * n) / total}%`;
  return (
    <div className="anatomy">
      <div className="track">
        {spans.map((s, i) => (
          <span
            key={i}
            className={`seg k-${s.kind}`}
            style={{ left: pct(s.start), width: pct(s.length) }}
            title={`${s.label} (${KIND_LABEL[s.kind]}): ${tok(s.length)} tok`}
          />
        ))}
        {shared > 0 && <span className="reused" style={{ width: pct(shared) }} title={`reusable prefix: ${tok(shared)} tok`} />}
      </div>
      <div className="legend">
        {(Object.keys(KIND_LABEL) as SpanKind[])
          .filter((k) => spans.some((s) => s.kind === k))
          .map((k) => (
            <span key={k}><i className={`k-${k}`} />{KIND_LABEL[k]}</span>
          ))}
        {shared > 0 && <span><i className="reused-key" />reusable from previous turn</span>}
      </div>
    </div>
  );
}

export function CallView({ index, onOpen }: { index: number; onOpen: (i: number) => void }) {
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCall(null);
    api.call(index).then(setCall, (e: unknown) => setError(String(e)));
  }, [index]);
  if (error) return <p className="err">{error}</p>;
  if (!call) return <p className="hint">Loading…</p>;

  const reread = call.promptChars - call.sharedChars;
  const byKind = new Map<SpanKind, number>();
  for (const s of call.anatomy) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + s.length);

  return (
    <div className="detail">
      <h2>
        {call.jobLabel}
        {call.npc && <> · {call.npc}</>} <small>{call.time} · {call.seconds.toFixed(1)} s · {call.thinking ? "thinking" : "no thinking"}</small>
      </h2>

      <h3>Prompt anatomy <small>{tok(call.promptChars)} tok</small></h3>
      <AnatomyBar spans={call.anatomy} total={call.promptChars} shared={call.sharedChars} />
      {call.previousIndex !== null ? (
        <p className="cache">
          Unchanged since this NPC's previous {call.jobLabel.toLowerCase()} call (
          <a onClick={() => onOpen(call.previousIndex!)}>#{call.previousIndex}</a>): <b>{tok(call.sharedChars)} tok</b> reusable,{" "}
          <b className="bad">{tok(reread)} tok</b> to re-read ({Math.round((100 * reread) / call.promptChars)}%).
        </p>
      ) : (
        <p className="cache">No earlier call of this kind for this NPC: the whole prompt is read.</p>
      )}

      <table className="kinds">
        <tbody>
          {[...byKind.entries()].map(([k, n]) => (
            <tr key={k}>
              <td><i className={`k-${k}`} /> {KIND_LABEL[k]}</td>
              <td className="num">{tok(n)} tok</td>
              <td className="num">{Math.round((100 * n) / call.promptChars)}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Reply</h3>
      <pre className="reply">{call.replyFull || "(empty)"}</pre>
      {call.reasoning && (
        <details>
          <summary>Thinking ({call.reasoning.length} chars)</summary>
          <pre>{call.reasoning}</pre>
        </details>
      )}
      <details>
        <summary>Sections ({call.anatomy.length})</summary>
        <table className="spans">
          <tbody>
            {call.anatomy.map((s, i) => (
              <tr key={i}>
                <td><i className={`k-${s.kind}`} /></td>
                <td>{s.label}</td>
                <td className="num">{tok(s.length)}</td>
                <td className="num">{s.start < call.sharedChars ? (s.start + s.length <= call.sharedChars ? "reused" : "partly") : "re-read"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details>
        <summary>Full request</summary>
        <pre>{JSON.stringify(call.request, null, 1)}</pre>
      </details>
    </div>
  );
}
