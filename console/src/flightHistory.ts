import type { Telemetry } from "./api";

export const SAMPLE_INTERVAL_MS = 1000;
export const HISTORY_DURATION_MS = 120_000;
export const MAX_PACKET_AGE_MS = 2500;

export const flightMetrics = [
  { key: "groundspeed_mps", label: "Ground speed", unit: "m/s", color: "#59cee6" },
  { key: "relative_alt_m", label: "Relative altitude", unit: "m", color: "#a6b6fe" },
  { key: "climb_mps", label: "Vertical speed", unit: "m/s", color: "#75dfb5" },
  { key: "voltage_v", label: "Battery voltage", unit: "V", color: "#e8b46d" }
] as const;

export type FlightMetric = typeof flightMetrics[number]["key"];
export type FlightPoint = {
  at: number;
  frames: number | null;
  values: Record<FlightMetric, number | null>;
};

export function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function currentTelemetry(telemetry?: Telemetry): Telemetry | undefined {
  const age = finite(telemetry?.age_ms);
  return (telemetry?.status === "LIVE" || telemetry?.status === "PARTIAL") &&
    age != null && age >= 0 && age <= MAX_PACKET_AGE_MS ? telemetry : undefined;
}

export function recordFlightPoint(history: FlightPoint[], telemetry: Telemetry | undefined, now: number): FlightPoint[] {
  const sample = currentTelemetry(telemetry);
  const live = sample?.status === "LIVE" && sample.heartbeat_fresh && sample.attitude_fresh;
  const frames = live ? finite(sample.frames_total) : null;
  const last = history.at(-1);
  const expired = history.findIndex(point => point.at >= now - HISTORY_DURATION_MS);
  const retained = expired === 0 || !history.length ? history : history.slice(expired < 0 ? history.length : expired);
  const previousFrames = last?.frames ?? (frames !== null ? [...retained].reverse().find(point => point.frames !== null)?.frames : null);
  const reset = frames !== null && previousFrames != null && frames < previousFrames;
  if (!reset && (last?.frames === frames || (frames === null && retained.length === 0))) return retained;
  const values = {
    groundspeed_mps: live ? finite(sample.groundspeed_mps) : null,
    relative_alt_m: live ? finite(sample.relative_alt_m) : null,
    climb_mps: live ? finite(sample.climb_mps) : null,
    voltage_v: live ? finite(sample.voltage_v) : null
  };
  return [...(reset ? [] : retained), { at: now, frames, values }];
}

export function flightCsv(points: FlightPoint[]): string {
  const header = ["sampled_utc", ...flightMetrics.map(metric => metric.key)];
  const rows = points.filter(point => point.frames !== null).map(point => [
    new Date(point.at).toISOString(), ...flightMetrics.map(metric => point.values[metric.key] ?? "")
  ].join(","));
  return [header.join(","), ...rows].join("\r\n");
}

export const TREND_WIDTH = 264;
export const TREND_HEIGHT = 52;

export function trendGeometry(points: FlightPoint[], key: FlightMetric, now: number, duration: number) {
  const first = now - duration;
  const visible = points.filter(point => point.at >= first && point.at <= now);
  const values = visible.flatMap(point => point.values[key] ?? []);
  if (!values.length) return { paths: [], min: null, max: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * .12, .1);
  const paths: [number, number][][] = [];
  let previousAt: number | null = null;
  let path: [number, number][] = [];
  for (const point of visible) {
    const value = point.values[key];
    if (value == null || (previousAt != null && point.at - previousAt > 3 * SAMPLE_INTERVAL_MS)) {
      if (path.length) paths.push(path);
      path = [];
    }
    if (value != null) {
      const x = (point.at - first) / duration * TREND_WIDTH;
      const y = (max + padding - value) / (max - min + 2 * padding) * TREND_HEIGHT;
      path.push([x, y]);
    }
    previousAt = point.at;
  }
  if (path.length) paths.push(path);
  return { paths, min, max };
}
