import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import StationBoot, { useStationBoot, type BootData } from "./StationBoot";
import { getHealth, getMissions, getVehicles } from "./api";

vi.mock("./api", () => ({ getHealth: vi.fn(), getVehicles: vi.fn(), getMissions: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function Harness({ result }: { result: (value: BootData) => void }) {
  const apply = useCallback((value: BootData) => result(value), [result]);
  const boot = useStationBoot(apply);
  return boot.dismissed ? <h1>Flight monitoring</h1> : <StationBoot {...boot}/>;
}

const health = {
  service: "vihanga-standalone", status: "ok", deployment: "LOCAL_STATION",
  physical_flight_control: false, live_vehicle_stream: false
};

describe("station startup", () => {
  it("reports all three checks before opening the operator workspace", async () => {
    const result = vi.fn();
    vi.mocked(getHealth).mockResolvedValue(health);
    vi.mocked(getVehicles).mockResolvedValue([]);
    vi.mocked(getMissions).mockResolvedValue([]);
    render(<Harness result={result}/>);
    const open = await screen.findByRole("button", { name: "Open ground station" });
    expect(screen.getByRole("progressbar", { name: "Startup checks completed" }).getAttribute("value")).toBe("3");
    expect(open.closest("section")?.querySelector(".station-mark")?.getAttribute("data-phase")).toBe("ready");
    fireEvent.click(open);
    expect(screen.getByRole("heading", { name: "Flight monitoring" })).toBeTruthy();
    expect(result).toHaveBeenCalledWith({ health, vehicles: [], missions: [] });
  });

  it("starts the logo motion during checks, then cleans it up if reduced motion is enabled", async () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
    Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
    let change: (() => void) | undefined;
    const preference = {
      matches: false,
      addEventListener: vi.fn((_event, callback: () => void) => { change = callback; }),
      removeEventListener: vi.fn()
    };
    vi.stubGlobal("matchMedia", () => preference);
    try {
      vi.mocked(getHealth).mockImplementation(() => new Promise(() => {}));
      const view = render(<Harness result={vi.fn()}/>);
      expect(animate).toHaveBeenCalledTimes(2);
      preference.matches = true;
      change?.();
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(animate).toHaveBeenCalledTimes(2);
      view.unmount();
      expect(preference.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    } finally {
      if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
      else Reflect.deleteProperty(HTMLElement.prototype, "animate");
      vi.unstubAllGlobals();
    }
  });

  it("can retry a recovered API without refreshing the page", async () => {
    vi.mocked(getHealth).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(health);
    vi.mocked(getVehicles).mockResolvedValue([]);
    vi.mocked(getMissions).mockResolvedValue([]);
    render(<Harness result={vi.fn()}/>);
    const retry = await screen.findByRole("button", { name: "Retry checks" });
    expect(screen.getAllByText("UNAVAILABLE")).toHaveLength(3);
    expect(retry.closest("section")?.querySelector(".station-mark")?.getAttribute("data-phase")).toBe("attention");
    expect(getVehicles).not.toHaveBeenCalled();
    fireEvent.click(retry);
    expect(await screen.findByRole("button", { name: "Open ground station" })).toBeTruthy();
  });

  it("loads the aircraft directory when only mission storage fails", async () => {
    const result = vi.fn();
    vi.mocked(getHealth).mockResolvedValue(health);
    vi.mocked(getVehicles).mockResolvedValue([]);
    vi.mocked(getMissions).mockRejectedValue(new Error("unavailable"));
    render(<Harness result={result}/>);
    expect(await screen.findByRole("button", { name: "Open workspace" })).toBeTruthy();
    expect(screen.getAllByText("READY")).toHaveLength(2);
    expect(result).toHaveBeenCalledWith({ health, vehicles: [] });
  });
});
