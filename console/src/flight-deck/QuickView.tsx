import { memo } from "react";
import {
  flightMetrics, trendGeometry, TREND_HEIGHT, TREND_WIDTH,
  type FlightMetric, type FlightPoint
} from "../flightHistory";
import "./QuickView.css";

const windowMs = 30_000;
const StripChart = memo(function StripChart({ points, now, metric }: {
  points: FlightPoint[]; now: number; metric: FlightMetric;
}) {
  const { paths } = trendGeometry(points, metric, now, windowMs);
  return <svg aria-hidden="true" viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`} preserveAspectRatio="none">
    {paths.map(path => path.length === 1
      ? <circle key={path[0][0]} cx={path[0][0]} cy={path[0][1]} r="2"/>
      : <polyline key={path[0][0]} points={path.map(pair => pair.join(",")).join(" ")}/>)}
  </svg>;
});

export default function QuickView({ values, points, now, onTrend }: {
  values: Record<FlightMetric, number | null>;
  points: FlightPoint[]; now: number; onTrend: (metric: FlightMetric) => void;
}) {
  return <div className="flight-quick-view" role="group" aria-label="Quick telemetry">
    {flightMetrics.map(metric => {
      const value = values[metric.key];
      return <button type="button" key={metric.key} onClick={() => onTrend(metric.key)}
        title={metric.label + " · last 30 seconds · open trend"}>
        <span className="quick-label">{metric.label}</span>
        <span className="quick-reading">
          <strong>{value == null ? "—" : value.toFixed(metric.key === "voltage_v" ? 2 : 1)}</strong>
          <small>{metric.unit}</small>
        </span>
        <StripChart metric={metric.key} points={points} now={now}/>
      </button>;
    })}
  </div>;
}
