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

const changedRate = (s: SegmentVolatility) => share(s.overTime.changed, s.overTime.pairs);

const sameRate = (s: SegmentVolatility) => share(s.acrossActors.identical, s.acrossActors.pairs);

const sameBarNamesRate = (s: SegmentVolatility) =>
  share(s.acrossActors.identicalExceptActor, s.acrossActors.pairs);

/** The sortable columns, by header, each with the value it sorts on. */
const COLUMNS: Record<string, (s: SegmentVolatility) => number | null> = {
  "Avg tok": (s) => s.avgTokens,
  Calls: (s) => s.calls,
  Changed: changedRate,
  "Append-only": (s) => share(s.overTime.appendOnly, s.overTime.changed),
  "Lines changed": (s) => s.overTime.avgChangedLineShare,
  "Same across actors": sameRate,
  "Bar names": sameBarNamesRate,
};

type Sort = { column: string; descending: boolean } | null;

/** Highest first, then lowest first, then back to prompt order. */
function nextSort(sort: Sort, column: string): Sort {
  if (sort?.column !== column) {
    return { column, descending: true };
  }

  return sort.descending ? { column, descending: false } : null;
}

/** Sorted by a column, segments without a value last; prompt order when unsorted. */
function sorted(segments: SegmentVolatility[], sort: Sort): SegmentVolatility[] {
  const value = sort && COLUMNS[sort.column];

  if (!sort || !value) {
    return segments;
  }

  return segments.toSorted((a, b) => {
    const x = value(a);
    const y = value(b);

    if (x === null || y === null) {
      return (x === null ? 1 : 0) - (y === null ? 1 : 0);
    }

    return sort.descending ? y - x : x - y;
  });
}

/** The three questions for each segment of a kind of call: shared across actors, changing over time, and how. */
export function Volatility({ kind }: { kind: string | null }) {
  const [report, setReport] = useState<{ calls: number; segments: SegmentVolatility[] } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(null);

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

  const header = (column: string) => (
    <th
      className={`num sortable${sort?.column === column ? " sorted" : ""}`}
      onClick={() => setSort(nextSort(sort, column))}
    >
      {column}
      {sort?.column === column && (sort.descending ? " ↓" : " ↑")}
    </th>
  );

  return (
    <div className="volatility">
      <p className="hint">
        {report.calls} calls{kind ? ` of kind ${kind}` : ""},{" "}
        {sort ? `sorted by ${sort.column.toLowerCase()}` : "segments in prompt order"}. Click a
        column to sort. <b>Changed</b>: how often a segment differed from the same actor's previous
        call. <b>Append-only</b> and <b>lines changed</b>: what those changes were.{" "}
        <b>Same across actors</b>: how often it matched another actor's latest call, as written and
        with actor names replaced. Segments that rarely change, and match across actors, belong
        early in the prompt, where a prefix cache can reuse them.
      </p>
      <table>
        <thead>
          <tr>
            {!kind && <th>Kind</th>}
            <th>Segment</th>
            {header("Avg tok")}
            {header("Calls")}
            {header("Changed")}
            <th></th>
            {header("Append-only")}
            {header("Lines changed")}
            {header("Same across actors")}
            {header("Bar names")}
          </tr>
        </thead>
        <tbody>
          {sorted(report.segments, sort).map((s) => {
            const changed = changedRate(s);
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
                  {percent(sameRate(s))}
                </td>
                <td className="num" title={`${identicalExceptActor} of ${pairs} pairs`}>
                  {percent(sameBarNamesRate(s))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
