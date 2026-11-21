import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import Bench from "./Bench";
import {
  getBenchCaptures, getBenchReport, startBenchCapture, stopBenchCapture,
  type BenchCapture, type BenchReceiver, type BenchReport, type Telemetry
} from "./api";

vi.mock("./api", () => ({
  benchDurations: [30, 60, 120, 300],
  getBenchCaptures: vi.fn(), getBenchReport: vi.fn(),
  startBenchCapture: vi.fn(), stopBenchCapture: vi.fn()
}));

const aircraftId = "AH-HW-001";
const stamp = "2026-11-21T07:00:00Z";
const capture: BenchCapture = {
  capture_id: "b70", vehicle_id: aircraftId, started_at: stamp,
  duration_seconds: 60, ended_at: stamp, status: "STOPPED", sample_count: 2
};
const primary: BenchReceiver = {
  status: "LIVE", transport: "PRIVATE_CLOUD_WSS", heartbeat_fresh: true, attitude_fresh: true,
  age_ms: 21, frame_rate_hz: 4, error_code: null, system_id: 1
};
const stale = { ...primary, status: "STALE", age_ms: 3001, heartbeat_fresh: false, attitude_fresh: false };
const backup = { ...primary, transport: "LOCAL_SERIAL_RECEIVE", age_ms: 0 };
const report: BenchReport = {
  capture,
  samples: [
    { elapsed_ms: 0, captured_at: stamp, primary, backup, active_source: "PRIMARY" },
    { elapsed_ms: 1000, captured_at: stamp, primary: stale, backup, active_source: "BACKUP" }
  ],
  summary: {
    sample_count: 2,
    primary: { configured_samples: 2, live_samples: 1, age_samples: 1, p50_ms: 21, p95_ms: 21, p99_ms: 21 },
    backup: { configured_samples: 2, live_samples: 2, age_samples: 2, p50_ms: 0, p95_ms: 0, p99_ms: 0 },
    events: [{ elapsed_ms: 1000, field: "primary", from: "LIVE", to: "STALE" }]
  }
};

beforeEach(() => {
  vi.mocked(getBenchCaptures).mockResolvedValue([]);
  vi.mocked(getBenchReport).mockResolvedValue(report);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("bench verification", () => {
  it("shows independent transport evidence, zero packet age, and the browser viewer", async () => {
    const telemetry = {
      primary_status: "LIVE", primary_transport: "PRIVATE_CLOUD_WSS", primary_age_ms: 21,
      primary_heartbeat_fresh: true, primary_attitude_fresh: true,
      backup_status: "LIVE", backup_transport: "LOCAL_SERIAL_RECEIVE", backup_age_ms: 0,
      backup_heartbeat_fresh: true, backup_attitude_fresh: true
    } as Telemetry;
    const usb = { status: "LIVE", transport: "BROWSER_SERIAL_READ_ONLY", heartbeat_fresh: true,
      attitude_fresh: true, age_ms: 7, frame_rate_5s_hz: 4, error_code: null } as Telemetry;

    render(<Bench aircraftId={aircraftId} telemetry={telemetry} browserTelemetry={usb} activeBrowser/>);
    expect(await screen.findByText("No captures saved for this aircraft.")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Primary receiver" })).getByText("21 ms")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Backup receiver" })).getByText("0 ms")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "This PC USB receiver" })).getByText("Active viewer")).toBeTruthy();
  });

  it("opens a saved report and jumps to a receiver outage in playback", async () => {
    vi.mocked(getBenchCaptures).mockResolvedValue([capture]);
    render(<Bench aircraftId={aircraftId} activeBrowser={false}/>);
    const event = await screen.findByRole("button", { name: "Review Primary change at 1.0 s" });
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("0.0 s");
    fireEvent.click(event);
    expect(screen.getByRole("slider").getAttribute("aria-valuetext")).toBe("1.0 s");
    expect(screen.getByText(/stale · 3001 ms/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export JSON" })).toBeTruthy();
  });

  it("starts and stops a capture under the selected aircraft", async () => {
    const running = { ...capture, status: "RECORDING" as const, ended_at: null, sample_count: 1 };
    vi.mocked(startBenchCapture).mockImplementation(async () => {
      vi.mocked(getBenchCaptures).mockResolvedValue([running]);
      return running;
    });
    vi.mocked(stopBenchCapture).mockImplementation(async () => {
      vi.mocked(getBenchCaptures).mockResolvedValue([capture]);
      return report;
    });
    render(<Bench aircraftId={aircraftId} activeBrowser={false}/>);
    fireEvent.change(screen.getByRole("combobox", { name: "Capture duration" }), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Start capture" }));
    const stop = await screen.findByRole("button", { name: "Stop capture" });
    expect(startBenchCapture).toHaveBeenCalledWith(aircraftId, 60);
    fireEvent.click(stop);
    expect(await screen.findByText("Capture review")).toBeTruthy();
    expect(stopBenchCapture).toHaveBeenCalledWith(aircraftId, capture.capture_id);
  });
});
