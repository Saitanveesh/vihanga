import { useEffect, useRef, useState } from "react";
import type { Telemetry } from "./api";
import {
  downloadCsv, flightCsv, flightMetrics, recordFlightPoint, trendGeometry,
  HISTORY_DURATION_MS, SAMPLE_INTERVAL_MS, TREND_HEIGHT, TREND_WIDTH, type FlightPoint
} from "./flightHistory";

export function useFlightTrend(telemetry?: Telemetry) {
  const latest = useRef(telemetry);
  const [trend, setTrend] = useState<{ now: number; points: FlightPoint[]; source: string | null }>(() => ({
    now: Date.now(), points: [], source: null
  }));
  useEffect(() => { latest.current = telemetry; }, [telemetry]);
  useEffect(() => {
    function sample() {
      const now = Date.now();
      const data = latest.current;
      setTrend(previous => {
        const source = data?.transport ? (data.active_source ?? "PRIMARY") + "/" + data.transport : previous.source;
        const points = source === previous.source ? previous.points : [];
        const next = recordFlightPoint(points, data, now);
        if (source === previous.source && next.length === 0 && previous.points.length === 0) return previous;
        return { now, source, points: next };
      });
    }
    sample();
    const interval = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);
  return trend;
}

export default function FlightTrend({ aircraftId, now: liveNow, points: livePoints }: {
  aircraftId: string; now: number; points: FlightPoint[];
}) {
  const [duration, setDuration] = useState(HISTORY_DURATION_MS);
  const [frozen, setFrozen] = useState<{ now: number; points: FlightPoint[] } | null>(null);
  const { now, points } = frozen ?? { now: liveNow, points: livePoints };
  const visible = points.filter(point => point.at >= now - duration && point.frames !== null);
  return <div className="station-trends">
    <div className="station-trend-grid">
      {flightMetrics.map(metric => {
        const { paths, min, max } = trendGeometry(points, metric.key, now, duration);
        return <section key={metric.key} className="station-trend-card" aria-label={metric.label + " trend"}>
          <div><strong>{metric.label}</strong><span>{min == null || max == null ? "—" :
            min === max ? min.toFixed(1) + " " + metric.unit :
            min.toFixed(1) + " to " + max.toFixed(1) + " " + metric.unit}</span></div>
          <svg viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            {[1, 2, 3].map(i => <line key={i} x1={i * TREND_WIDTH / 4} x2={i * TREND_WIDTH / 4} y1="0" y2={TREND_HEIGHT}/>)}
            <line x1="0" x2={TREND_WIDTH} y1={TREND_HEIGHT / 2} y2={TREND_HEIGHT / 2}/>
            {paths.map(path => path.length === 1
              ? <circle key={path[0][0]} cx={path[0][0]} cy={path[0][1]} r="2" fill={metric.color}/>
              : <polyline key={path[0][0]} points={path.map(point => point.join(",")).join(" ")} stroke={metric.color}/>)}
          </svg>
          {paths.length === 0 && <small className="station-trend-empty">Awaiting live samples</small>}
        </section>;
      })}
    </div>
    <div className="station-trend-controls">
      <div role="group" aria-label="Trend time window">
        {[30_000, HISTORY_DURATION_MS].map(period => <button key={period} type="button"
          aria-pressed={duration === period} onClick={() => setDuration(period)}>{period / 1000} s</button>)}
      </div>
      <span>{visible.length} {visible.length === 1 ? "sample" : "samples"} · {frozen ? "Paused" : "1 s sampling"}</span>
      <div>
        <button type="button" aria-pressed={Boolean(frozen)} disabled={!frozen && !visible.length}
          onClick={() => setFrozen(frozen ? null : { now, points })}>{frozen ? "Resume live" : "Pause charts"}</button>
        <button type="button" disabled={!aircraftId || !visible.length}
          onClick={() => downloadCsv(flightCsv(visible), "vihanga-" + aircraftId + "-telemetry.csv")}>Export CSV</button>
      </div>
    </div>
  </div>;
}
