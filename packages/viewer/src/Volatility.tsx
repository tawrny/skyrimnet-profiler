import { useEffect, useState } from "react";
import { api, type SegmentVolatility } from "./api.ts";

const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

const percent = (rate: number | null) => (rate === null ? "–" : `${Math.round(100 * rate)}%`);

function heat(rate: number): string {
  if (rate > 0.5) {
    return "hot";
  }

  if (rate > 0.2) {
    return "warm";
  }

  return "cool";
}

function RateBar({ rate }: { rate: number | null }) {
  return (
    <td className="ratebar">
      {rate !== null && <span style={{ width: `${100 * rate}%` }} className={heat(rate)} />}
    </td>
  );
}

/** The three questions for each segment of a kind of call: shared across actors, changing over time, and how. */
export function Volatility({ kind }: { kind: string | null }) {
  const [report, setReport] = useState<{ calls: number; segments: SegmentVolatility[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setReport(null);
    setError(null);
    api.volatility(kind).then(setReport, (e: unknown) => setError(String(e)));
  }, [kind]);

  if (error) {
    return <p className="err">{error}</p>;
  }

  if (!report) {
    return <p className="hint">Loading…</p>;
  }

  return (
    <div className="volatility">
      <p className="hint">
        {report.calls} calls{kind ? ` of kind ${kind}` : ""}, segments in prompt order.{" "}
        <b>Changed</b>: how often a segment differed from the same actor's previous call.{" "}
        <b>Append-only</b> and <b>lines changed</b>: what those changes were.{" "}
        <b>Same across actors</b>: how often it matched another actor's latest call, as written and
        with actor names replaced. Segments that rarely change, and match across actors, belong
        early in the prompt, where a prefix cache can reuse them.
      </p>
      <table>
        <thead>
          <tr>
            {!kind && <th>Kind</th>}
            <th>Segment</th>
            <th className="num">Avg tok</th>
            <th className="num">Calls</th>
            <th className="num">Changed</th>
            <th></th>
            <th className="num">Append-only</th>
            <th className="num">Lines changed</th>
            <th className="num">Same across actors</th>
            <th className="num">Bar names</th>
          </tr>
        </thead>
        <tbody>
          {report.segments.map((s) => {
            const changed = share(s.overTime.changed, s.overTime.pairs);
            const { pairs, identical, identicalExceptActor } = s.acrossActors;

            return (
              <tr key={`${s.kind}\u0000${s.name}`}>
                {!kind && <td>{s.kind}</td>}
                <td>{s.name}</td>
                <td className="num">{s.avgTokens}</td>
                <td className="num">{s.calls}</td>
                <td className="num" title={`${s.overTime.changed} of ${s.overTime.pairs} pairs`}>
                  {percent(changed)}
                </td>
                <RateBar rate={changed} />
                <td className="num">{percent(share(s.overTime.appendOnly, s.overTime.changed))}</td>
                <td className="num">{percent(s.overTime.avgChangedLineShare)}</td>
                <td className="num" title={`${identical} of ${pairs} pairs`}>
                  {percent(share(identical, pairs))}
                </td>
                <td className="num" title={`${identicalExceptActor} of ${pairs} pairs`}>
                  {percent(share(identicalExceptActor, pairs))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
