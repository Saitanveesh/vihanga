import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FlightTrend from "../FlightTrend";
import type { FlightPoint } from "../flightHistory";

afterEach(cleanup);

it("keeps review anchored while new readings arrive and clears the marker in a gap or on resume", () => {
  const onReview = vi.fn();
  const point: FlightPoint = {
    at: 6000, frames: 3, position: { latitude: 12, longitude: 77 },
    values: { groundspeed_mps: 0, relative_alt_m: 0, climb_mps: 0, voltage_v: 11.8 }
  };
  const props = { aircraftId: "A1", points: [point], onReview, now: 10000 };
  const view = render(<FlightTrend {...props}/>);
  fireEvent.click(screen.getByRole("button", { name: "Pause charts" }));
  const slider = screen.getByRole("slider", { name: "Review time" });
  fireEvent.change(slider, { target: { value: "6000" } });
  expect(onReview).toHaveBeenLastCalledWith(point);
  view.rerender(<FlightTrend {...props} now={13000} points={[]}/>);
  expect(screen.getByText(/12.00000, 77.00000/)).toBeTruthy();
  fireEvent.change(slider, { target: { value: "9000" } });
  expect(screen.getByText(/Telemetry gap/)).toBeTruthy();
  expect(onReview).toHaveBeenLastCalledWith(null);
  fireEvent.click(screen.getByRole("button", { name: "Resume live" }));
  expect(screen.queryByRole("slider")).toBeNull();
});
