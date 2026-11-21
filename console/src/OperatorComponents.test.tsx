import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import FlightInstruments from "./FlightInstruments";
import useDisplayTelemetry from "./useDisplayTelemetry";
import type { Telemetry } from "./api";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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
    expect(screen.getByText("NO DATA")).toBeTruthy();
    expect(screen.getByText("R —")).toBeTruthy();
    expect(screen.getByText("P —")).toBeTruthy();
    expect(screen.getByText("NO FC HEARTBEAT", { selector: ".readout-bad" })).toBeTruthy();
  });

  it("shows real roll and pitch without making a fake GPS position", () => {
    render(<FlightInstruments telemetry={data()}/>);
    expect(screen.getByText("R 5.7°")).toBeTruthy();
    expect(screen.getByText("P -11.5°")).toBeTruthy();
    expect(screen.getByText("FIX 1")).toBeTruthy();
    expect(screen.getByText("FC HEARTBEAT")).toBeTruthy();
  });

  it("retains trend history across an outage and starts a new trace on a different receiver", () => {
    vi.useFakeTimers();
    const sample = data();
    const view = render(<FlightInstruments telemetry={sample} aircraftId={sample.vehicle_id}/>);
    fireEvent.click(screen.getByRole("button", { name: "Telemetry trends" }));
    expect(screen.getByText("1 sample · 1 s sampling")).toBeTruthy();

    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id}/>);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("1 sample · 1 s sampling")).toBeTruthy();

    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id}
      telemetry={{ ...sample, transport: "LOCAL_SERIAL_RECEIVE", active_source: "BACKUP", groundspeed_mps: 14 }}/>);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("1 sample · 1 s sampling")).toBeTruthy();
    const speedTrend = screen.getByRole("region", { name: "Ground speed trend" });
    expect(speedTrend.textContent).toContain("14.0 m/s");
  });

  it("expires a stopped stream and accepts a newly received sample", () => {
    vi.useFakeTimers();
    function Display({ sample }: { sample: Telemetry }) {
      return <FlightInstruments telemetry={useDisplayTelemetry(sample)}/>;
    }
    const sample = data();
    const view = render(<Display sample={sample}/>);
    expect(screen.getByText("FC HEARTBEAT")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.getByText("TELEMETRY STALE")).toBeTruthy();
    expect(screen.getByText("R —")).toBeTruthy();
    view.rerender(<Display sample={{ ...sample, age_ms: 30, frames_total: 901 }}/>);
    expect(screen.getByText("R 5.7°")).toBeTruthy();
  });

  it("logs source changes and FC failsafe without inferring recovery from missing data", () => {
    const sample = data();
    const view = render(<FlightInstruments telemetry={sample} aircraftId={sample.vehicle_id}/>);
    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(screen.getByText("Telemetry live")).toBeTruthy();
    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id} telemetry={{ ...sample,
      active_source: "BACKUP", rc_failsafe_reported: true }}/>);
    expect(screen.getByText(/^Source: BACKUP/)).toBeTruthy();
    expect(screen.getByText("FC reports RC failsafe")).toBeTruthy();
    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id} telemetry={{ ...sample, status: "STALE" }}/>);
    expect(screen.getByText("Telemetry stale")).toBeTruthy();
    expect(screen.queryByText("FC reports RC failsafe cleared")).toBeNull();
    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id} telemetry={{ ...sample, rc_failsafe_reported: false }}/>);
    expect(screen.getByText("FC reports RC failsafe cleared")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add marker" }));
    expect(screen.getByText("Operator marker")).toBeTruthy();

    view.rerender(<FlightInstruments aircraftId="AH-HW-002"/>);
    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(screen.queryByText("Operator marker")).toBeNull();
    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id} telemetry={sample}/>);
    fireEvent.click(screen.getByRole("button", { name: "Events" }));
    expect(screen.getByText("Operator marker")).toBeTruthy();
  });

  it("freezes trend review while live telemetry continues to collect", () => {
    vi.useFakeTimers();
    const sample = data();
    const view = render(<FlightInstruments aircraftId={sample.vehicle_id} telemetry={sample}/>);
    fireEvent.click(screen.getByRole("button", { name: "Telemetry trends" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause charts" }));
    view.rerender(<FlightInstruments aircraftId={sample.vehicle_id}
      telemetry={{ ...sample, groundspeed_mps: 8, frames_total: 901 }}/>);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("1 sample · Paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume live" }));
    expect(screen.getByText("2 samples · 1 s sampling")).toBeTruthy();
  });
});
