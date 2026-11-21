import { describe, expect, it } from "vitest";
import type { Telemetry } from "./api";
import { currentTelemetry, flightCsv, recordFlightPoint, trendGeometry, HISTORY_DURATION_MS } from "./flightHistory";

function reading(frames: number, speed = 0): Telemetry {
  return {
    vehicle_id: "TEST-01", transport: "LOCAL_SERIAL_RECEIVE", frames_total: frames,
    age_ms: 130, status: "LIVE", heartbeat_fresh: true, attitude_fresh: true,
    groundspeed_mps: speed, relative_alt_m: 0, climb_mps: -1.2, voltage_v: null
  } as Telemetry;
}

describe("flight telemetry trends", () => {
  it("preserves measured zero and negative climb, and skips duplicate projections", () => {
    const points = recordFlightPoint([], reading(101), 1000);
    expect(recordFlightPoint(points, reading(101), 2000)).toBe(points);
    expect(points[0].values).toMatchObject({ groundspeed_mps: 0, climb_mps: -1.2, voltage_v: null });
    expect(flightCsv(points)).toContain("1970-01-01T00:00:01.000Z,0,0,-1.2,");
  });

  it("breaks the plotted line on missing or stale data and removes expired points", () => {
    let points = recordFlightPoint([], reading(101, 9), 1000);
    const stale = { ...reading(102), age_ms: 2700 };
    expect(currentTelemetry(stale)).toBeUndefined();
    points = recordFlightPoint(points, stale, 2000);
    points = recordFlightPoint(points, reading(103, 12), 3000);
    expect(trendGeometry(points, "groundspeed_mps", 3000, 30_000).paths).toHaveLength(2);
    expect(flightCsv(points).split("\r\n")).toHaveLength(3);
    expect(recordFlightPoint(points, undefined, 3001 + HISTORY_DURATION_MS)).toEqual([]);
  });

  it("starts a new trace when the receiver frame counter restarts", () => {
    const original = recordFlightPoint([], reading(101), 1000);
    const gap = recordFlightPoint(original, undefined, 2000);
    const next = recordFlightPoint(gap, reading(1), 3000);
    expect(next.map(point => point.frames)).toEqual([1]);
  });
});
