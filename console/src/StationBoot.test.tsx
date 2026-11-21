import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import BootSplash from "./BootSplash";
import { useStationBoot, type BootData } from "./StationBoot";
import { getHealth, getMissions, getVehicles } from "./api";

vi.mock("./api", () => ({ getHealth: vi.fn(), getVehicles: vi.fn(), getMissions: vi.fn() }));

const initialAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  if (initialAnimate) Object.defineProperty(Element.prototype, "animate", initialAnimate);
  else Reflect.deleteProperty(Element.prototype, "animate");
});

function Harness({ result }: { result: (value: BootData) => void }) {
  const boot = useStationBoot(result);
  if (!boot.initialized) return null;
  return <>
    <h1>Flight monitoring</h1>
    {!boot.ready && <button disabled={!boot.finished} onClick={boot.retry}>Retry startup checks</button>}
  </>;
}

const health = {
  service: "vihanga-standalone", status: "ok", deployment: "LOCAL_STATION",
  physical_flight_control: false, live_vehicle_stream: false
};

describe("station splash", () => {
  it("displays the emblem and wordmark and hands off automatically after the reveal", () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    const complete = vi.fn();
    const view = render(<BootSplash ready={false} onComplete={complete}/>);
    const emblem = screen.getByRole("img", { name: "VIHANGA" });
    expect(emblem.localName).toBe("svg");
    expect(screen.getByRole("main").childElementCount).toBe(1);
    expect(view.container.textContent).toBe("VIHANGA");
    expect(screen.queryByRole("button")).toBeNull();
    expect(animate).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(complete).not.toHaveBeenCalled();

    view.rerender(<BootSplash ready onComplete={complete}/>);
    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate).toHaveBeenLastCalledWith([{ backgroundColor: "#000" }, { backgroundColor: "transparent" }], expect.any(Object));
    act(() => vi.advanceTimersByTime(400));
    expect(complete).toHaveBeenCalledOnce();
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("stops active animations and hands off immediately when motion is reduced", () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ cancel }));
    Object.defineProperty(Element.prototype, "animate", { configurable: true, value: animate });
    let change: (() => void) | undefined;
    const preference = {
      matches: false,
      addEventListener: vi.fn((_event: string, callback: () => void) => { change = callback; }),
      removeEventListener: vi.fn()
    };
    vi.stubGlobal("matchMedia", () => preference);
    const complete = vi.fn();
    const view = render(<BootSplash ready onComplete={complete}/>);
    expect(complete).not.toHaveBeenCalled();
    preference.matches = true;
    act(() => change?.());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledOnce();

    view.unmount();
    expect(preference.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});

describe("station startup checks", () => {
  it("automatically opens the workspace after loading startup data", async () => {
    const result = vi.fn();
    vi.mocked(getHealth).mockResolvedValue(health);
    vi.mocked(getVehicles).mockResolvedValue([]);
    vi.mocked(getMissions).mockResolvedValue([]);
    render(<Harness result={result}/>);
    expect(await screen.findByRole("heading", { name: "Flight monitoring" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry startup checks" })).toBeNull();
    expect(result).toHaveBeenCalledWith({ health, vehicles: [], missions: [] });
  });

  it("can retry a recovered API without blocking the workspace", async () => {
    const result = vi.fn();
    vi.mocked(getHealth).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(health);
    vi.mocked(getVehicles).mockResolvedValue([]);
    vi.mocked(getMissions).mockResolvedValue([]);
    render(<Harness result={result}/>);
    const retry = await screen.findByRole("button", { name: "Retry startup checks" });
    expect(getVehicles).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Flight monitoring" })).toBeTruthy();
    await act(async () => fireEvent.click(retry));
    expect(screen.queryByRole("button", { name: "Retry startup checks" })).toBeNull();
    expect(result).toHaveBeenLastCalledWith({ health, vehicles: [], missions: [] });
  });

  it("loads the aircraft directory when only mission storage fails", async () => {
    const result = vi.fn();
    vi.mocked(getHealth).mockResolvedValue(health);
    vi.mocked(getVehicles).mockResolvedValue([]);
    vi.mocked(getMissions).mockRejectedValue(new Error("unavailable"));
    render(<Harness result={result}/>);
    expect(await screen.findByRole("button", { name: "Retry startup checks" })).toBeTruthy();
    expect(result).toHaveBeenCalledWith({ health, vehicles: [] });
  });
});
