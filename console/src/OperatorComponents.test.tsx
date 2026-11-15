import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import FlightInstruments from "./FlightInstruments";
import type { Telemetry } from "./api";

afterEach(cleanup);

function data(): Telemetry {
  return {
    vehicle_id: "AH-HW-001", transport: "PRIVATE_CLOUD_WSS",
    status: "LIVE", error_code: null, flight_control_enabled: false,
    heartbeat_fresh: true, attitude_fresh: true,
    latitude: null, longitude: null,
    roll_deg: 5.7, pitch_deg: -11.5, yaw_deg: 1.2,
    relative_alt_m: 11.72, groundspeed_mps: 0, climb_mps: 0,
    voltage_v: 11.89, battery_pct: 74,
    gps_fix_type: 1, satellites: 0,
    gps2_fix_type: null, gps2_satellites: null,
    battery_current_a: null, airspeed_mps: null, throttle_pct: null,
    frame_rate_5s_hz: 6.2, mode: "STABILIZE", armed: false,
    age_ms: 120, frames_total: 900, rejected_frames: 0,
    track_points: 0, message_counts: {HEARTBEAT: 100}
  };
}

describe("operator components: verified telemetry only", () => {
  it("shows no data when flight attitude is stale", () => {
    render(<FlightInstruments telemetry={{
      ...data(), attitude_fresh: false, roll_deg: null, pitch_deg: null,
      yaw_deg: null, heartbeat_fresh: false
    }}/>);
    expect(screen.getAllByText("NO DATA").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("R —")).toBeTruthy();
    expect(screen.getByText("P —")).toBeTruthy();
    expect(screen.getByText("NO DATA", { selector: ".readout-bad" })).toBeTruthy();
  });

  it("shows real roll and pitch without making a fake GPS position", () => {
    render(<FlightInstruments telemetry={data()}/>);
    expect(screen.getByText("R 5.7°")).toBeTruthy();
    expect(screen.getByText("P -11.5°")).toBeTruthy();
    expect(screen.getByText("FIX 1")).toBeTruthy();
    expect(screen.getByText("FRESH")).toBeTruthy();
  });

});
