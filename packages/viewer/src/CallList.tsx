import type { CallSummary } from "./api.ts";

const fmtTime = (t: string) => t.slice(11, 19);

export function CallList(props: {
  calls: CallSummary[];
  selected: number | null;
  onSelect: (i: number) => void;
}) {
  const max = Math.max(10, ...props.calls.map((c) => c.seconds));

  return (
    <ol className="calls">
      {props.calls.map((c) => (
        <li
          key={c.index}
          className={c.index === props.selected ? "sel" : ""}
          onClick={() => props.onSelect(c.index)}
        >
          <div className="row">
            <span className="time">{fmtTime(c.time)}</span>
            <span className={`job job-${c.job}`}>{c.jobLabel}</span>
            {c.npc && <span className="npc">{c.npc}</span>}
            {!c.thinking && (
              <span className="tag" title="sent without thinking">
                no-think
              </span>
            )}
            {c.gaveUp && (
              <span className="tag bad" title="SkyrimNet hung up before the reply finished">
                gave up
              </span>
            )}
          </div>
          <div className="row small">
            <span className="bar">
              <span style={{ width: `${(100 * c.seconds) / max}%` }} />
            </span>
            <span className="num">{c.seconds.toFixed(1)} s</span>
            <span className="num">{(c.promptTokens / 1000).toFixed(1)}k tok</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
