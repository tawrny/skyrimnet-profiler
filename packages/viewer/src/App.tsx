import { useEffect, useState } from "react";
import { api, type CallSummary, type KindCount } from "./api.ts";
import { CallList } from "./CallList.tsx";
import { CallView } from "./CallView.tsx";
import { Volatility } from "./Volatility.tsx";

type Tab = "calls" | "volatility";

const REFRESH_MS = 5000;
const ALL = "";

export function App() {
  const [tab, setTab] = useState<Tab>("calls");
  const [kinds, setKinds] = useState<KindCount[]>([]);
  const [kind, setKind] = useState(ALL);
  const [calls, setCalls] = useState<CallSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;

    const load = () =>
      Promise.all([api.kinds(), api.calls(kind || null)])
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
  }, [kind]);

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
