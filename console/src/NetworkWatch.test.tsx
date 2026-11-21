import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NetworkWatch, { assessAircraft, assessGcs } from "./NetworkWatch";
import type { Telemetry } from "./api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const connected = {
  vehicle_id: "AH-HW-001", status: "LIVE", transport: "VIHANGA_CLOUD_V2",
  heartbeat_fresh: true, attitude_fresh: true, age_ms: 180,
  frame_rate_5s_hz: 24.5, radio_rssi_raw: 89,
  radio_remote_rssi_raw: 101, radio_rx_errors: 2,
  active_source: "PRIMARY", backup_status: "LIVE"
} as Telemetry;

describe("network watch assessments", () => {
  it("never invents an RF percentage or a signal quality from API latency", () => {
    expect(assessGcs(24, false).headline).toBe("API REACHABLE");
    expect(assessGcs(1200, false).condition).toBe("WARN");
    expect(assessGcs(null, true).condition).toBe("DOWN");
    expect(assessAircraft(connected, "AH-HW-001").condition).toBe("OK");
    expect(assessAircraft({...connected,heartbeat_fresh:false}, "AH-HW-001").headline).toBe("STALE DATA");
    expect(assessAircraft({...connected,age_ms:2300}, "AH-HW-001").headline).toBe("DELAYED");
    expect(assessAircraft({...connected,status:"OFFLINE"}, "AH-HW-001").condition).toBe("DOWN");
    expect(assessAircraft(connected, "").condition).toBe("UNKNOWN");
  });

  it("polls the real operations API and displays only reported aircraft values", async () => {
    const probe = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({service:"vihanga-standalone",status:"ok"})
    });
    vi.stubGlobal("fetch", probe);
    render(<NetworkWatch aircraftId="AH-HW-001" telemetry={connected}
      viewerConnected={true}/>);
    await waitFor(() => expect(probe).toHaveBeenCalledWith("/api/v1/health",
      expect.objectContaining({cache:"no-store"})));
    fireEvent.click(screen.getByRole("button", {name:/LINK MONITOR/}));
    expect(screen.getByText("Local radio RSSI")).toBeTruthy();
    expect(screen.getByText("89 raw")).toBeTruthy();
    expect(screen.getByText("101 raw")).toBeTruthy();
    expect(screen.getByText("WebSocket connected")).toBeTruthy();
    expect(screen.getByText(/not Wi-Fi strength/i)).toBeTruthy();
    expect(screen.queryByText("89%")).toBeNull();
  });

  it("informs when a previously healthy aircraft link drops and then recovers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({status:"ok"})
    }));
    const view = render(<NetworkWatch aircraftId="AH-HW-001" telemetry={connected}
      viewerConnected={false}/>);
    fireEvent.click(screen.getByRole("button", {name:/LINK MONITOR/}));
    view.rerender(<NetworkWatch aircraftId="AH-HW-001"
      telemetry={{...connected,status:"STALE",heartbeat_fresh:false}}
      viewerConnected={false}/>);
    await waitFor(() => expect(screen.getByText(/Aircraft telemetry degraded:/)).toBeTruthy());
    view.rerender(<NetworkWatch aircraftId="AH-HW-001" telemetry={connected}
      viewerConnected={true}/>);
    await waitFor(() => expect(screen.getByText("Aircraft telemetry restored")).toBeTruthy());
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("shows unavailable raw radio data rather than calculating strength from transport status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const noRadio = {...connected, radio_rssi_raw:null, radio_remote_rssi_raw:null, radio_rx_errors:null};
    render(<NetworkWatch aircraftId="AH-HW-001" telemetry={noRadio}
      viewerConnected={false}/>);
    fireEvent.click(screen.getByRole("button", {name:/LINK MONITOR/}));
    await waitFor(() => expect(screen.getByText("API OFFLINE")).toBeTruthy());
    expect(screen.getAllByText("Not reported").length).toBe(2);
    expect(screen.getByText(/uncalibrated MAVLink RADIO_STATUS/)).toBeTruthy();
  });
});
