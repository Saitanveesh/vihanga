import { useEffect, useRef, useState } from "react";
import type { Telemetry } from "./api";
import {
  flightCsv, flightMetrics, recordFlightPoint, trendGeometry,
  HISTORY_DURATION_MS, SAMPLE_INTERVAL_MS, TREND_HEIGHT, TREND_WIDTH, type FlightPoint
} from "./flightHistory";

export function useFlightTrend(telemetry?: Telemetry) {
  const latest = useRef(telemetry);
  const [trend, setTrend] = useState<{ now: number; points: FlightPoint[] }>(() => ({
    now: Date.now(), points: []
  }));
  useEffect(() => { latest.current = telemetry; }, [telemetry]);
  useEffect(() => {
    function sample() {
      const now = Date.now();
      setTrend(previous => ({ now, points: recordFlightPoint(previous.points, latest.current, now) }));
    }
    sample();
    const interval = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);
  return trend;
}

function download(points: FlightPoint[], aircraftId: string) {
  const url = URL.createObjectURL(new Blob([flightCsv(points)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "vihanga-" + aircraftId + "-telemetry.csv";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function FlightTrend({ aircraftId, now, points }: {
  aircraftId: string; now: number; points: FlightPoint[];
}) {
  const [duration, setDuration] = useState(HISTORY_DURATION_MS);
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
      <span>{visible.length} samples · 1 s sampling</span>
      <button type="button" disabled={!aircraftId || visible.length === 0}
        onClick={() => download(visible, aircraftId)}>Export CSV</button>
    </div>
  </div>;
}
