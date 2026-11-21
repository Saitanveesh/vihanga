import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import OperationsPanel from "./OperationsPanel";
import type { Telemetry } from "./api";

afterEach(cleanup);

const reading = (overrides: Partial<Telemetry> = {}): Telemetry => ({
  vehicle_id: "AH-HW-001", transport: "PRIVATE_CLOUD_WSS",
  status: "LIVE", error_code: null, flight_control_enabled: false,
  heartbeat_fresh: true, attitude_fresh: true,
  primary_status: "LIVE", primary_transport: "PRIVATE_CLOUD_WSS",
  primary_heartbeat_fresh: true, primary_attitude_fresh: true,
  active_source: "PRIMARY", backup_status: "NOT_CONFIGURED",
  backup_transport: null, backup_error_code: null,
  backup_heartbeat_fresh: false, backup_attitude_fresh: false,
  radio_rssi_raw: null, radio_remote_rssi_raw: null,
  radio_rx_errors: null, radio_fixed_packets: null,
  sensor_health: null,
  ...overrides
} as Telemetry);

describe("read-only fleet link diagnostics", () => {
  it("does not enable backup switching without real FC heartbeat and attitude", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<OperationsPanel aircraftId="AH-HW-001"
      telemetry={reading({backup_status:"WAITING_FOR_FRAMES",backup_transport:"LOCAL_TCP_RECEIVE"})}
      busy={false} onClose={vi.fn()} onConfigureBackup={vi.fn()}
      onSelect={onSelect} onRemoveBackup={vi.fn()}/>);
    const useBackup = screen.getByRole("button", {name:"Use backup"}) as HTMLButtonElement;
    expect(useBackup.disabled).toBe(true);
    expect(screen.getAllByText("not reported")).toHaveLength(5);
    expect(screen.getAllByText("—", {selector:".ops-two-metrics strong"}).length).toBeGreaterThanOrEqual(2);

    rerender(<OperationsPanel aircraftId="AH-HW-001"
      telemetry={reading({backup_status:"LIVE",backup_transport:"LOCAL_TCP_RECEIVE",
        backup_heartbeat_fresh:true,backup_attitude_fresh:true,
        radio_rssi_raw:172,radio_remote_rssi_raw:146,
        sensor_health:{gyroscope:"HEALTHY",accelerometer:"HEALTHY",
          magnetometer:"FAULT",gps:"HEALTHY",rc_receiver:"FAULT"}})}
      busy={false} onClose={vi.fn()} onConfigureBackup={vi.fn()}
      onSelect={onSelect} onRemoveBackup={vi.fn()}/>);
    expect((screen.getByRole("button",{name:"Use backup"}) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button",{name:"Use backup"}));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith("BACKUP");
    expect(screen.getByText("172")).toBeTruthy();
    expect(screen.getByText("146")).toBeTruthy();
    expect(screen.getAllByText("fault")).toHaveLength(2);
  });

  it("recognizes RC channels from Pixhawk without fabricating a GCS backup receiver", () => {
    const onConfigureBackup = vi.fn();
    render(<OperationsPanel aircraftId="AH-HW-001"
      telemetry={reading({
        rc_input_status:"CHANNELS_REPORTED",rc_channels_fresh:true,
        rc_channel_count:6,rc_rssi_raw:null,backup_transport:null
      })}
      busy={false} onClose={vi.fn()} onConfigureBackup={onConfigureBackup}
      onSelect={vi.fn()} onRemoveBackup={vi.fn()}/>);
    expect(screen.getByText("FC CHANNELS RECEIVED · RF UNVERIFIED")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getAllByText("Not reported").length).toBeGreaterThan(0);
    expect(screen.getByText("No standby receiver")).toBeTruthy();
    expect(screen.getByRole("button",{name:"Add backup telemetry link"})).toBeTruthy();
  });

  it("never permits an unverified primary return", () => {
    const onSelect = vi.fn();
    const bad = reading({
      active_source: "BACKUP", transport:"LOCAL_TCP_RECEIVE",
      primary_status:"RECONNECTING",primary_heartbeat_fresh:false,
      primary_attitude_fresh:false,
      backup_status:"LIVE",backup_heartbeat_fresh:true,backup_attitude_fresh:true
    });
    render(<OperationsPanel aircraftId="AH-HW-001" telemetry={bad}
      busy={false} onClose={vi.fn()} onConfigureBackup={vi.fn()}
      onSelect={onSelect} onRemoveBackup={vi.fn()}/>);
    const restore = screen.getByRole("button",{name:"Restore primary"}) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    fireEvent.click(restore);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
