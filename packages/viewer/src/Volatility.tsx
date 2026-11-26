import { useEffect, useState } from "react";
import type { SectionStat } from "@skyrimnet/relay/prompt";
import { api } from "./api.ts";

/** How often each context section changed between consecutive dialogue prompts of the same NPC. */
export function Volatility() {
  const [rows, setRows] = useState<SectionStat[] | null>(null);
  const [last, setLast] = useState(2000);
  useEffect(() => {
    setRows(null);
    api.volatility(last).then(setRows, () => setRows([]));
  }, [last]);
  return (
    <div className="volatility">
      <p className="hint">
        For each section of the dialogue context: how often it differed from the same NPC's previous prompt. Sections that rarely
        change belong before the history (cached); the ones that change belong at the end. Over the last{" "}
        <select value={last} onChange={(e) => setLast(Number(e.target.value))}>
          {[200, 500, 2000, 10000].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>{" "}
        calls.
      </p>
      {!rows ? (
        <p className="hint">Loading…</p>
      ) : (
        <table>
          <thead>
            <tr><th>Section</th><th>Changed</th><th></th><th className="num">Avg tok</th><th className="num">Pairs</th></tr>
          </thead>
          <tbody>
            {rows.filter((r) => r.pairs >= 3).map((r) => {
              const rate = r.changed / r.pairs;
              return (
                <tr key={r.section}>
                  <td>{r.section}</td>
                  <td className="num">{Math.round(100 * rate)}%</td>
                  <td className="ratebar"><span style={{ width: `${100 * rate}%` }} className={rate > 0.5 ? "hot" : rate > 0.2 ? "warm" : "cool"} /></td>
                  <td className="num">{r.avgTokens}</td>
                  <td className="num">{r.pairs}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
