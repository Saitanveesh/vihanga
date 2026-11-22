import { useEffect, useRef, useState } from "react";
import { flightMetrics, type FlightPoint } from "../flightHistory";
import { appendSample, beginRun, listRuns, loadSamples, sampleAt, type Run, type Sample } from "./archive";
import "./recorder.css";

type Props = {
  scope: string; aircraft: string; visible: boolean; latest?: FlightPoint;
  receiver: string | null; onReview?: (point: FlightPoint | null) => void;
};
const clock = (ms: number) => new Date(ms).toLocaleTimeString();

export default function SessionRecorder({ scope, aircraft, visible, latest, receiver, onReview }: Props) {
  const [active, setActive] = useState<Run | null>(null);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, select] = useState("");
  const [samples, setSamples] = useState<Sample[]>([]);
  const [at, seek] = useState(0);
  const [playing, play] = useState(false);
  const [error, report] = useState("");
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const lastWrite = useRef<Promise<void>>(Promise.resolve());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    listRuns(scope).then(list => {
      if (!cancelled) setRuns(list.sort((a, b) => b.started - a.started));
    }).catch(() => { if (!cancelled) report("Browser recording storage unavailable."); });
    return () => { cancelled = true; };
  }, [visible, scope, active]);

  useEffect(() => {
    if (!active || !latest || latest.at < active.started) return;
    const sample = { ...latest, receiver, run: active.id };
    lastWrite.current = appendSample(sample).then(() => {
      if (alive.current) setCount(n => n + 1);
    }).catch(() => {
      if (alive.current) { setActive(null); report("Recording stopped. Storage write failed. Earlier samples are saved."); }
    });
  }, [active, latest, receiver]);

  useEffect(() => {
    let cancelled = false;
    play(false);
    setSamples([]);
    if (!selected || !visible) return;
    setLoading(true);
    lastWrite.current.then(() => loadSamples(selected)).then(rows => {
      if (!cancelled) { setSamples(rows); seek(rows[0]?.at ?? 0); }
    }).catch(() => { if (!cancelled) report("Could not open this recording."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selected, visible]);

  const end = samples.at(-1)?.at ?? 0;
  useEffect(() => {
    if (!playing || !visible) return;
    let previous = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const delta = now - previous;
      previous = now;
      seek(value => Math.min(end, value + delta));
    }, 200);
    return () => window.clearInterval(timer);
  }, [playing, visible, end]);
  useEffect(() => { if (at >= end) play(false); }, [at, end]);
  const point = sampleAt(samples, at);
  useEffect(() => {
    if (!visible) return;
    onReview?.(point);
    return () => onReview?.(null);
  }, [point, visible, onReview]);

  async function start() {
    setStarting(true); report("");
    try {
      const run = await beginRun(scope);
      if (alive.current) { select(""); setCount(0); setActive(run); }
    } catch { if (alive.current) report("Could not start a recording in this browser."); }
    finally { if (alive.current) setStarting(false); }
  }
  if (!visible) return null;
  return <section className="session-recorder" aria-label="Session recorder">
    <header>
      <strong>{active ? "Recording" : "Recordings"}</strong>
      <span>{active ? count + " samples saved" : aircraft}</span>
      {active ? <button onClick={() => { setActive(null); select(active.id); }}>Stop &amp; review</button> :
        <button disabled={!aircraft || starting} onClick={() => void start()}>Record session</button>}
    </header>
    {error && <p role="alert">{error}</p>}
    {!active && <label>Saved on this browser <select value={selected} onChange={e => select(e.target.value)}>
      <option value="">Select a session</option>
      {runs.map(run => <option key={run.id} value={run.id}>{new Date(run.started).toLocaleString()}</option>)}
    </select></label>}
    {selected && !active && (loading ? <p>Loading samples…</p> : !samples.length ? <p>No telemetry samples recorded.</p> : <>
      <div className="session-transport">
        <button disabled={end === samples[0].at} onClick={() => { if (at >= end) seek(samples[0].at); play(!playing); }}>
          {playing ? "Pause" : "Play"}
        </button>
        <input type="range" aria-label="Recording time" min={samples[0].at} max={end} step={1}
          value={Math.round(at)} onChange={e => { play(false); seek(Number(e.target.value)); }}/>
        <output>{clock(at)}</output>
      </div>
      <div className="session-metrics">{flightMetrics.map(metric => <div key={metric.key}>
        <span>{metric.label}</span><strong>{point?.values[metric.key]?.toFixed(metric.key === "voltage_v" ? 2 : 1) ?? "—"} <small>{metric.unit}</small></strong>
      </div>)}</div>
      <footer>{point ? (point.receiver ?? "Unknown receiver") + (point.position ? " · Recorded fix" : " · No recorded fix") : "Telemetry gap"}</footer>
    </>)}
  </section>;
}
