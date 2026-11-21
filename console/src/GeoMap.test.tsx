import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import GeoMap, { buildGeometry, visibleWaypointLabels, type MapPoint, type RoutePoint } from "./GeoMap";

const stats = vi.hoisted(() => ({ resizeCalls: 0, fitPaddingLeft: null as number | null }));
vi.mock("maplibre-gl", () => {
  class MapStub {
    container: HTMLElement;
    source: {setData: (_data: unknown) => void} | null = null;
    dragPan = {disable: () => undefined, enable: () => undefined};
    constructor(options: {container: HTMLElement}) { this.container = options.container; }
    addControl() {}
    on() {}
    isStyleLoaded() { return true; }
    getSource() { return this.source; }
    addSource() { this.source = {setData: () => undefined}; }
    addLayer() {}
    resize() { stats.resizeCalls++; }
    remove() {}
    setStyle() { this.source = null; }
    flyTo() {}
    fitBounds(_bounds: unknown, options: {padding: {left: number}}) {
      stats.fitPaddingLeft = options.padding.left;
    }
  }
  class MarkerStub {
    element: HTMLElement;
    constructor(options: {element: HTMLElement}) { this.element = options.element; }
    setLngLat(_lnglat: number[]) { return this; }
    addTo(map: MapStub) { map.container.appendChild(this.element); return this; }
    remove() { this.element.remove(); }
  }
  return { default: {
    Map: MapStub, Marker: MarkerStub, NavigationControl: class {},
    LngLatBounds: class { extend() {} }
  }};
});

afterEach(() => { cleanup(); stats.resizeCalls = 0; stats.fitPaddingLeft = null; });

const route: RoutePoint[] = [
  {latitude: 12.9715, longitude: 77.5945, altitude_m: 35},
  {latitude: 12.9717, longitude: 77.5949, altitude_m: 35}
];
const origin: MapPoint = {latitude: 12.9716, longitude: 77.5946};

describe("geographic map visual geometry regression", () => {
  it("keeps every survey waypoint in geometry while hiding overlapping number labels", () => {
    const dense: RoutePoint[] = Array.from({length:15}, (_, index) => ({
      latitude:12.9715 + index * 0.000003,
      longitude:77.5945 + index * 0.000003,
      altitude_m:35
    }));
    const labels = visibleWaypointLabels(dense, 17);
    expect(labels.size).toBe(1);
    expect(labels.has(0)).toBe(true);
    const chosen = visibleWaypointLabels(dense, 17, 10);
    expect(chosen.has(10)).toBe(true);
    expect(chosen.has(0)).toBe(false);
    const geometry = buildGeometry([], dense, null, []);
    expect(geometry.features.filter(item => item.properties.kind === "waypoint")).toHaveLength(15);
    expect(geometry.features.some(item => item.properties.kind === "route")).toBe(true);
  });

  it("provides waypoint point geometry even before there is a line", () => {
    const first = buildGeometry([], route.slice(0,1), null, []);
    expect(first.features.filter(f => f.properties.kind === "waypoint")).toHaveLength(1);
    expect(first.features.filter(f => f.properties.kind === "route")).toHaveLength(0);
    const both = buildGeometry([], route, origin, []);
    expect(both.features.filter(f => f.properties.kind === "waypoint")).toHaveLength(2);
    expect(both.features.filter(f => f.properties.kind === "route")).toHaveLength(1);
    expect(both.features.filter(f => f.properties.kind === "aircraft")).toHaveLength(1);
  });

  it("keeps survey coverage, planned route and observed flight track distinct", () => {
    const polygon: MapPoint[] = [
      {latitude: 12.970, longitude: 77.590},
      {latitude: 12.970, longitude: 77.595},
      {latitude: 12.975, longitude: 77.595},
      {latitude: 12.975, longitude: 77.590}
    ];
    const track: MapPoint[] = [
      {latitude: 12.965, longitude: 77.582},
      {latitude: 12.966, longitude: 77.583}
    ];
    const result = buildGeometry(polygon, route, null, track);
    const kinds = result.features.map(f => f.properties.kind);
    expect(kinds).toContain("survey");
    expect(kinds).toContain("outline");
    expect(kinds).toContain("route");
    expect(kinds).toContain("observed_track");
    expect(kinds.filter(k => k === "waypoint")).toHaveLength(2);
    expect(kinds).not.toContain("aircraft");
    const coverage = result.features.find(f => f.properties.kind === "survey");
    expect(coverage.geometry.coordinates[0][0]).toEqual([77.59, 12.97]);
    expect(coverage.geometry.coordinates[0].at(-1)).toEqual([77.59, 12.97]);
  });

  it("draws visible, numbered HTML markers and resizes the underlying map", () => {
    const props = {
      polygon: [] as MapPoint[], route: route.slice(0, 1),
      track: [] as MapPoint[], position: null,
      drawing: true, basemap: "satellite" as const,
      centerSignal: 0, fitSignal: 0,
      onMapClick: vi.fn(), onVertexMove: vi.fn()
    };
    const view = render(<GeoMap {...props}/>);
    expect(view.container.querySelectorAll(".vihanga-waypoint")).toHaveLength(1);
    expect(view.container.querySelector(".vihanga-waypoint")?.textContent).toBe("1");
    const before = stats.resizeCalls;
    window.dispatchEvent(new Event("resize"));
    expect(stats.resizeCalls).toBeGreaterThan(before);
    view.rerender(<GeoMap {...props} route={route}/>);
    const pins = view.container.querySelectorAll(".vihanga-waypoint");
    expect(pins).toHaveLength(2);
    expect(Array.from(pins).map(pin => pin.textContent)).toEqual(["1","2"]);
    view.rerender(<GeoMap {...props} route={[]}/>);
    expect(view.container.querySelectorAll(".vihanga-waypoint")).toHaveLength(0);
  });

  it("links selected planner row to the matching visible pin", () => {
    const onWaypointSelect = vi.fn();
    const props = {
      polygon: [] as MapPoint[], route,
      track: [] as MapPoint[], position: null,
      drawing: true, basemap: "satellite" as const,
      centerSignal: 0, fitSignal: 0,
      selectedWaypoint: null as number | null,
      onWaypointSelect, onMapClick: vi.fn(), onVertexMove: vi.fn()
    };
    const view = render(<GeoMap {...props}/>);
    const pins = view.container.querySelectorAll(".vihanga-waypoint");
    fireEvent.click(pins[1]);
    expect(onWaypointSelect).toHaveBeenCalledWith(1);
    expect(props.onMapClick).not.toHaveBeenCalled();
    view.rerender(<GeoMap {...props} selectedWaypoint={1}/>);
    const selected = view.container.querySelectorAll(".vihanga-waypoint.selected");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("2");
  });

  it("fits the route with padding bounded by canvas width", () => {
    const props = {
      polygon: [] as MapPoint[], route,
      track: [] as MapPoint[], position: null, drawing: false,
      basemap: "streets" as const, centerSignal: 0, fitSignal: 1,
      fitLeftPadding: 414,
      onMapClick: vi.fn(), onVertexMove: vi.fn()
    };
    const view = render(<GeoMap {...props}/>);
    expect(stats.fitPaddingLeft).toBe(380);
    view.rerender(<GeoMap {...props} fitLeftPadding={76}/>);
    expect(stats.fitPaddingLeft).toBe(76);
  });
});
