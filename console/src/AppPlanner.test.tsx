import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "./App";
import { getHealth, getMissions, getVehicles, previewCircularSurvey, type SurveyPreview } from "./api";
import type { MapPoint } from "./GeoMap";

vi.mock("./api", async importOriginal => ({
  ...await importOriginal<typeof import("./api")>(),
  getHealth: vi.fn(), getMissions: vi.fn(), getVehicles: vi.fn(), previewCircularSurvey: vi.fn()
}));
vi.mock("./NetworkWatch", () => ({ default: () => null }));
vi.mock("./GeoMap", () => ({
  default: ({ polygon, route, onMapClick }: {
    polygon: MapPoint[]; route: MapPoint[]; onMapClick: (point: MapPoint) => void
  }) => <button onClick={() => onMapClick({ latitude: 12 + polygon.length / 1000, longitude: 77 })}>
    Map test target ({route.length} points)
  </button>
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("discards a circular result when the user clears its boundary while it is loading", async () => {
  vi.mocked(getHealth).mockResolvedValue({
    service: "vihanga-standalone", status: "ok", deployment: "LOCAL_STATION",
    physical_flight_control: false, live_vehicle_stream: false
  });
  vi.mocked(getVehicles).mockResolvedValue([]);
  vi.mocked(getMissions).mockResolvedValue([]);
  let resolvePreview!: (value: SurveyPreview) => void;
  vi.mocked(previewCircularSurvey).mockImplementation(() => new Promise(resolve => { resolvePreview = resolve; }));

  render(<App/>);
  fireEvent.click(await screen.findByRole("button", { name: "Open ground station" }));
  fireEvent.click(screen.getByRole("button", { name: /^plan$/i }));
  fireEvent.click(screen.getByRole("button", { name: "Circular" }));
  fireEvent.click(screen.getByRole("button", { name: "Draw boundary" }));
  const map = await screen.findByRole("button", { name: "Map test target (0 points)" });
  for (let index = 0; index < 3; index++) fireEvent.click(map);
  fireEvent.click(screen.getByRole("button", { name: "Generate coverage route" }));
  expect(previewCircularSurvey).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Clear boundary" }));
  await act(async () => resolvePreview({
    pattern: "CIRCULAR", waypoints: [{ latitude: 12, longitude: 77, altitude_m: 40 }],
    polygon: [], lane_count: 1, area_m2: 5, route_distance_m: 1, estimated_duration_s: 1,
    requires_route_review: true, status: "PREVIEW_ONLY"
  }));
  expect(screen.getByRole("button", { name: "Map test target (0 points)" })).toBeTruthy();
  expect(screen.queryByText("PREVIEW READY")).toBeNull();
});
