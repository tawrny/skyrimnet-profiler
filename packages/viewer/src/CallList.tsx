import type { CallSummary } from "./api.ts";

const clock = (iso: string) => new Date(iso).toLocaleTimeString();

const seconds = (ms: number | null) => (ms === null ? 0 : ms / 1000);

export function CallList(props: {
  calls: CallSummary[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const max = Math.max(10, ...props.calls.map((c) => seconds(c.durationMs)));

  return (
    <ol className="calls">
      {props.calls.map((c) => (
        <li
          key={c.id}
          className={c.id === props.selected ? "sel" : ""}
          onClick={() => props.onSelect(c.id)}
        >
          <div className="row">
            <span className="time">{clock(c.time)}</span>
            <span className="job">{c.kind}</span>
            {c.actor && <span className="npc">{c.actor}</span>}
            {c.status !== 200 && <span className="tag bad">{c.status ?? "no reply"}</span>}
          </div>
          <div className="row small">
            <span className="bar">
              <span style={{ width: `${(100 * seconds(c.durationMs)) / max}%` }} />
            </span>
            <span className="num">{seconds(c.durationMs).toFixed(1)} s</span>
            <span className="num">{(c.promptTokens / 1000).toFixed(1)}k tok</span>
            {c.usage.cachedInputTokens !== null && c.usage.inputTokens ? (
              <span className="num" title="input tokens the provider served from cache">
                {Math.round((100 * c.usage.cachedInputTokens) / c.usage.inputTokens)}% cached
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
