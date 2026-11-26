import { useEffect, useState } from "react";
import { api, type CallSort, type CallSummary, type KindCount } from "./api.ts";
import { CallList } from "./CallList.tsx";
import { CallView } from "./CallView.tsx";
import { Volatility } from "./Volatility.tsx";

type Tab = "calls" | "volatility";

const REFRESH_MS = 5000;
const ALL = "";

const SORTS: Record<CallSort, string> = {
  time: "Time",
  duration: "Duration",
  promptTokens: "Prompt size",
  cachedShare: "Cached share",
  cost: "Cost",
};

const isSort = (s: string): s is CallSort => s in SORTS;

/** Bands of the share of input tokens the provider served from cache. */
const CACHE_BANDS: Record<string, { label: string; atLeast: number | null; below: number | null }> =
  {
    any: { label: "Any cache share", atLeast: null, below: null },
    low: { label: "Under 20% cached", atLeast: null, below: 0.2 },
    mid: { label: "20–80% cached", atLeast: 0.2, below: 0.8 },
    high: { label: "80%+ cached", atLeast: 0.8, below: null },
  };

export function App() {
  const [tab, setTab] = useState<Tab>("calls");
  const [kinds, setKinds] = useState<KindCount[]>([]);
  const [kind, setKind] = useState(ALL);
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<CallSort>("time");
  const [descending, setDescending] = useState(true);
  const [band, setBand] = useState("any");

  useEffect(() => {
    let live = true;

    const load = () =>
      Promise.all([
        api.kinds(),
        api.calls({
          kind: kind || null,
          sort,
          descending,
          cachedAtLeast: CACHE_BANDS[band]?.atLeast ?? null,
          cachedBelow: CACHE_BANDS[band]?.below ?? null,
        }),
      ])
        .then(([k, page]) => {
          if (!live) {
            return;
          }

          setKinds(k);
          setCalls(page.calls);
          setTotal(page.total);
          setError(null);
        })
        .catch((e: unknown) => live && setError(String(e)));

    load();
    const timer = setInterval(load, REFRESH_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [kind, sort, descending, band]);

  const allCalls = kinds.reduce((sum, k) => sum + k.calls, 0);

  return (
    <div className="app">
      <header>
        <h1>Volatility</h1>
        <nav>
          <button className={tab === "calls" ? "on" : ""} onClick={() => setTab("calls")}>
            Calls
          </button>
          <button className={tab === "volatility" ? "on" : ""} onClick={() => setTab("volatility")}>
            Segment volatility
          </button>
        </nav>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value={ALL}>All kinds ({allCalls})</option>
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.kind} ({k.calls})
            </option>
          ))}
        </select>
        <span className="meta">
          {error ? <span className="err">API unreachable: {error}</span> : `${total} calls`}
        </span>
      </header>
      {tab === "calls" ? (
        <main className="split">
          <aside>
            <div className="listbar">
              <select
                value={sort}
                onChange={(e) => isSort(e.target.value) && setSort(e.target.value)}
              >
                {Object.entries(SORTS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setDescending(!descending)}
                title={descending ? "Highest or newest first" : "Lowest or oldest first"}
              >
                {descending ? "↓" : "↑"}
              </button>
              <select value={band} onChange={(e) => setBand(e.target.value)}>
                {Object.entries(CACHE_BANDS).map(([value, b]) => (
                  <option key={value} value={value}>
                    {b.label}
                  </option>
                ))}
              </select>
            </div>
            <CallList calls={calls} selected={selected} onSelect={setSelected} />
          </aside>
          <section>
            {selected === null ? (
              <p className="hint">Pick a call to see its segments.</p>
            ) : (
              <CallView id={selected} onOpen={setSelected} />
            )}
          </section>
        </main>
      ) : (
        <main>
          <Volatility kind={kind || null} />
        </main>
      )}
    </div>
  );
}
