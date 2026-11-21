import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConnectionSettings, { validateConnection, type ConnectionRequest } from "./ConnectionSettings";
import type { Telemetry } from "./api";

vi.mock("./BrowserSerial", () => ({
  getBrowserSerial: () => ({ requestPort: vi.fn(), getPorts: vi.fn().mockResolvedValue([]) })
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const callbacks = () => ({
  onConnect: vi.fn().mockResolvedValue(undefined),
  onConnectBrowserSerial: vi.fn().mockResolvedValue(undefined),
  onActivate: vi.fn().mockResolvedValue(undefined),
  onRemoveBackup: vi.fn().mockResolvedValue(undefined),
  onDisconnect: vi.fn().mockResolvedValue(undefined),
  onClearError: vi.fn(),
  onClose: vi.fn()
});

function panel(props: Partial<Parameters<typeof ConnectionSettings>[0]> = {}) {
  const c = callbacks();
  render(<ConnectionSettings
    aircraftName="Bench Pixhawk"
    aircraftId="AH-HW-001"
    telemetry={undefined}
    initialRole="PRIMARY"
    busy={false}
    error=""
    {...c}
    {...props}
  />);
  return c;
}

const defaultRequest: ConnectionRequest = {
  role: "PRIMARY", method: "UDP", origin: "", username: "", password: "",
  viewerToken: "", serialPort: "COM3", baud: 57600, port: 14550, systemId: 1
};

describe("ConnectionSettings", () => {
  it("keeps common transports visible and advanced UDP available", async () => {
    const c = panel();
    expect(screen.getByRole("dialog", {name: "Connection settings"})).toBeTruthy();
    for (const label of ["This PC USB", "Direct Wi-Fi", "Private relay"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByText("Advanced connections"));
    fireEvent.click(screen.getByRole("button", {name: "UDP"}));
    const ip = screen.getByDisplayValue("127.0.0.1") as HTMLInputElement;
    expect(ip.readOnly).toBe(true);
    expect(screen.getByDisplayValue("14550")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", {name: "Connect primary"}));
    expect(c.onConnect).toHaveBeenCalledWith(expect.objectContaining({
      role: "PRIMARY", method: "UDP", port: 14550, systemId: 1
    }));
    expect(screen.getByText(/Receive-only telemetry/)).toBeTruthy();
  });

  it("shows clear primary/backup receiver management and refuses replacement", () => {
    const connected = {
      primary_transport: "VIHANGA_CLOUD_V2", primary_status: "LIVE",
      backup_transport: "DIRECT_LAN_WSS", backup_status: "LIVE",
      active_source: "PRIMARY"
    } as Telemetry;
    const c = panel({telemetry: connected, initialRole: "BACKUP"});
    expect(screen.getByText("Direct Wi-Fi")).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Connect backup"})).toBeNull();
    expect(screen.queryByText("CONNECTION DETAILS")).toBeNull();
    expect(screen.queryByText("Reconnect authorized USB radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name: "Use backup"}));
    expect(c.onActivate).toHaveBeenCalledWith("BACKUP");
    fireEvent.click(screen.getByRole("button", {name: "Remove backup"}));
    expect(c.onRemoveBackup).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", {name: "Disconnect all"}));
    expect(c.onDisconnect).toHaveBeenCalledOnce();
  });

  it("does not configure standby without a primary or simulate link failover", () => {
    const c = panel({initialRole:"BACKUP"});
    expect(screen.getByText(/Connect a primary receiver before configuring/)).toBeTruthy();
    expect(screen.queryByRole("button", {name: "Connect backup"})).toBeNull();
    expect(c.onConnect).not.toHaveBeenCalled();
  });

  it("allows one USB connection action only when backup is free", () => {
    const primary = {
      primary_transport:"VIHANGA_CLOUD_V2", primary_status:"LIVE",
      backup_transport:null, backup_status:"OFFLINE", active_source:"PRIMARY"
    } as Telemetry;
    const c = panel({telemetry: primary, initialRole:"BACKUP"});
    fireEvent.click(screen.getByRole("button", {name:"This PC USB"}));
    expect(screen.queryByText("Reconnect authorized USB radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", {name:"Connect USB"}));
    expect(c.onConnectBrowserSerial).toHaveBeenCalledWith(57600, 1);

    cleanup();
    const configured = {...primary,
      backup_transport:"BROWSER_SERIAL_READ_ONLY", backup_status:"LIVE"} as Telemetry;
    const second = panel({telemetry: configured, initialRole:"BACKUP"});
    expect(screen.getByText("USB on this PC")).toBeTruthy();
    expect(screen.queryByRole("button", {name:"Connect USB"})).toBeNull();
    expect(screen.getByRole("button", {name:"Remove backup"})).toBeTruthy();
    expect(second.onConnectBrowserSerial).not.toHaveBeenCalled();
  });

  it("clears stale errors when changing connection role or transport", () => {
    const c = panel({error:"Old receiver failure"});
    fireEvent.click(screen.getByRole("button", {name:"Backup"}));
    expect(c.onClearError).toHaveBeenCalled();
  });

  it("validates LAN private address, token, ports, and serial device", () => {
    expect(validateConnection({...defaultRequest,method:"LAN",
      origin:"https://192.168.137.176:8765",viewerToken:"L".repeat(40)})).toBe(null);
    expect(validateConnection({...defaultRequest,method:"LAN",
      origin:"https://192.168.137.176:8765/",viewerToken:"L".repeat(40)})).toBe(null);
    expect(validateConnection({...defaultRequest,method:"LAN",
      origin:"https://8.8.8.8:8765",viewerToken:"L".repeat(40)})).toMatch(/private IPv4/);
    expect(validateConnection({...defaultRequest,method:"LAN",
      origin:"http://192.168.1.5:8765",viewerToken:"L".repeat(40)})).toMatch(/HTTPS/);
    expect(validateConnection({...defaultRequest,method:"BROKER",
      origin:"https://example.ts.net:8443",viewerToken:"short"})).toMatch(/32 characters/);
    expect(validateConnection({...defaultRequest,method:"SERIAL",serialPort:"not-a-port"})).toMatch(/COM3/);
    expect(validateConnection({...defaultRequest,method:"TCP",port:10})).toMatch(/1024/);
  });

  it("handles Escape and keeps credentials out of persistent form state", () => {
    const c = panel();
    fireEvent.keyDown(document, {key:"Escape"});
    expect(c.onClose).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem("vihanga.receiver.origin.cloud.v1")).toBeNull();
  });

  it("displays a receiver API error without closing the dialog", () => {
    panel({error:"Aircraft not registered"});
    expect(screen.getByRole("alert").textContent).toContain("Aircraft not registered");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
