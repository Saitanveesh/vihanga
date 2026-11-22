import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import QuickView from "./QuickView";

afterEach(cleanup);
it("distinguishes a measured zero from unavailable data and opens the chosen trend", () => {
  const select = vi.fn();
  render(<QuickView points={[]} now={0} onTrend={select}
    values={{ groundspeed_mps: 0, relative_alt_m: null, climb_mps: -1.2, voltage_v: 11.84 }}/>);
  expect(screen.getByRole("button", { name: /Ground speed/ }).textContent).toContain("0.0");
  expect(screen.getByRole("button", { name: /Relative altitude/ }).textContent).toContain("—");
  const battery = screen.getByRole("button", { name: /Battery voltage/ });
  expect(battery.textContent).toContain("11.84");
  fireEvent.click(battery);
  expect(select).toHaveBeenCalledWith("voltage_v");
});
