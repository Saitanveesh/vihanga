import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConnectionSettings, { validateConnection, type ConnectionRequest } from "./ConnectionSettings";
import type { Telemetry } from "./api";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const callbacks = () => ({
  onConnect: vi.fn().mockResolvedValue(undefined),
  onActivate: vi.fn().mockResolvedValue(undefined),
  onRemoveBackup: vi.fn().mockResolvedValue(undefined),
  onDisconnect: vi.fn().mockResolvedValue(undefined),
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
  it("provides six real transport options and readable local UDP fields", async () => {
    const c = panel();
    expect(screen.getByRole("dialog", {name: "Connection settings"})).toBeTruthy();
    for (const label of ["Serial / USB", "UDP", "TCP", "Direct Wi-Fi",
       "Vihanga Cloud", "Private relay"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", {name: /UDP Local listener/}));
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
    expect(screen.getByText("DIRECT LAN WSS")).toBeTruthy();
    expect((screen.getByRole("button", {name: "Connect backup"}) as HTMLButtonElement).disabled).toBe(true);
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
    expect((screen.getByRole("button", {name: "Connect backup"}) as HTMLButtonElement).disabled).toBe(true);
    expect(c.onConnect).not.toHaveBeenCalled();
  });

  it("validates LAN private address, token, ports, and serial device", () => {
    expect(validateConnection({...defaultRequest,method:"LAN",
      origin:"https://192.168.137.176:8765",viewerToken:"L".repeat(40)})).toBe(null);
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
