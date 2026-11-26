import { useEffect, useMemo, useState } from "react";
import { api, type CallSummary } from "./api.ts";
import { CallList } from "./CallList.tsx";
import { CallView } from "./CallView.tsx";
import { Volatility } from "./Volatility.tsx";

type Tab = "calls" | "volatility";
const REFRESH_MS = 5000;

export function App() {
  const [tab, setTab] = useState<Tab>("calls");
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [job, setJob] = useState("all");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .calls(800)
        .then((r) => {
          if (!live) return;
          setCalls(r.calls);
          setTotal(r.total);
          setError(null);
        })
        .catch((e: unknown) => live && setError(String(e)));
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const jobs = useMemo(() => [...new Set(calls.map((c) => c.jobLabel))].sort(), [calls]);
  const shown = job === "all" ? calls : calls.filter((c) => c.jobLabel === job);

  return (
    <div className="app">
      <header>
        <h1>SkyrimNet Calls</h1>
        <nav>
          <button className={tab === "calls" ? "on" : ""} onClick={() => setTab("calls")}>
            Calls
          </button>
          <button className={tab === "volatility" ? "on" : ""} onClick={() => setTab("volatility")}>
            Section volatility
          </button>
        </nav>
        <span className="meta">
          {error ? (
            <span className="err">relay API unreachable: {error}</span>
          ) : (
            `${total} calls logged`
          )}
        </span>
      </header>
      {tab === "calls" ? (
        <main className="split">
          <aside>
            <select value={job} onChange={(e) => setJob(e.target.value)}>
              <option value="all">All jobs</option>
              {jobs.map((j) => (
                <option key={j}>{j}</option>
              ))}
            </select>
            <CallList calls={shown} selected={selected} onSelect={setSelected} />
          </aside>
          <section>
            {selected === null ? (
              <p className="hint">Pick a call to see its prompt anatomy.</p>
            ) : (
              <CallView index={selected} onOpen={setSelected} />
            )}
          </section>
        </main>
      ) : (
        <main>
          <Volatility />
        </main>
      )}
    </div>
  );
}
