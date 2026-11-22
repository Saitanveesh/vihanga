import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import GeoMap, { buildGeometry, type MapPoint, type RoutePoint } from "./GeoMap";

const stats = vi.hoisted(() => ({
  resizeCalls: 0, fitPaddingLeft: null as number | null,
  layers: new Set<string>(), images: new Set<string>(),
  data: null as ReturnType<typeof buildGeometry> | null,
  click: null as (() => void) | null,
  drag: null as (() => void) | null, centers: [] as [number, number][],
  pressVertex: null as ((event: object) => void) | null,
  release: null as (() => void) | null,
  hit: undefined as number | undefined
}));
vi.mock("maplibre-gl", () => {
  class MapStub {
    source: { setData: (data: ReturnType<typeof buildGeometry>) => void } | null = null;
    dragPan = { disable: () => undefined, enable: () => undefined };
    addControl() {}
    on(event: string, handler: (() => void) | string, delegated?: (event: object) => void) {
      if (typeof handler === "string") {
        if (handler === "boundary-handles" && delegated) stats.pressVertex = delegated;
        return;
      }
      if (event === "mouseup") stats.release = handler;
      if (event === "click") stats.click = handler;
      if (event === "dragstart") stats.drag = handler;
    }
    isStyleLoaded() { return true; }
    getSource() { return this.source; }
    addSource(_name: string, { data }: { data: ReturnType<typeof buildGeometry> }) {
      stats.data = data;
      this.source = { setData: updated => { stats.data = updated; } };
    }
    addLayer(layer: { id: string }) { stats.layers.add(layer.id); }
    getLayer(id: string) { return stats.layers.has(id); }
    hasImage(id: string) { return stats.images.has(id); }
    addImage(id: string) { stats.images.add(id); }
    project() { return { x: 43, y: 40 }; }
    queryRenderedFeatures(box: number[][]) {
      if (box[0][0] > 43 || box[1][0] < 43) return []; return stats.hit ? [{ properties: { index: stats.hit } }] : []; }
    resize() { stats.resizeCalls++; }
    remove() {}
    setStyle() { this.source = null; }
    stop() {}
    flyTo() {}
    jumpTo({ center }: { center: [number, number] }) { stats.centers.push(center); }
    fitBounds(_bounds: unknown, options: { padding: { left: number } }) { stats.fitPaddingLeft = options.padding.left; }
  }
  return { default: { Map: MapStub, NavigationControl: class {}, LngLatBounds: class { extend() {} } } };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  stats.resizeCalls = 0; stats.fitPaddingLeft = null;
  stats.layers.clear(); stats.images.clear(); stats.data = null; stats.hit = undefined;
  stats.drag = null;
  stats.centers = [];
});

function mockBadgeCanvas() {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, fillText() {}, getImageData() { return {}; }
  } as unknown as CanvasRenderingContext2D);
}

const route: RoutePoint[] = [
  {latitude: 12.9715, longitude: 77.5945, altitude_m: 35},
  {latitude: 12.9717, longitude: 77.5949, altitude_m: 35}
];
const origin: MapPoint = {latitude: 12.9716, longitude: 77.5946};

describe("geographic map visual geometry regression", () => {
  it("uses identical coordinates for the circular line and its waypoint features", () => {
    const ring: RoutePoint[] = Array.from({ length: 25 }, (_, index) => ({
      latitude: origin.latitude + .0002 * Math.sin(index * Math.PI / 12),
      longitude: origin.longitude + .0002 * Math.cos(index * Math.PI / 12),
      altitude_m: 35
    }));
    const geometry = buildGeometry([], ring, null, [], 10);
    const pins = geometry.features.filter(item => item.properties.kind === "waypoint");
    const line = geometry.features.find(item => item.properties.kind === "route");
    expect(pins).toHaveLength(ring.length);
    expect(pins.map(pin => pin.geometry.coordinates)).toEqual(line.geometry.coordinates);
    expect(pins.filter(pin => pin.properties.selected).map(pin => pin.properties.index)).toEqual([11]);
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

  it("uses native map layers for the line, dots and numbers and replaces stale source data", () => {
    mockBadgeCanvas();
    const props = {
      polygon: [] as MapPoint[], route: route.slice(0, 1),
      track: [] as MapPoint[], position: null,
      drawing: true, basemap: "satellite" as const,
      centerSignal: 0, fitSignal: 0,
      onMapClick: vi.fn(), onVertexMove: vi.fn()
    };
    const view = render(<GeoMap {...props}/>);
    expect([...stats.layers]).toEqual(expect.arrayContaining(["route-line", "waypoint-points", "waypoint-numbers", "waypoint-selected"]));
    expect([...stats.images]).toEqual(["wp-1"]);
    const before = stats.resizeCalls;
    window.dispatchEvent(new Event("resize"));
    expect(stats.resizeCalls).toBeGreaterThan(before);
    view.rerender(<GeoMap {...props} route={route}/>);
    expect(stats.data?.features.filter(item => item.properties.kind === "waypoint")).toHaveLength(2);
    expect([...stats.images]).toEqual(["wp-1", "wp-2"]);
    view.rerender(<GeoMap {...props} route={[]}/>);
    expect(stats.data?.features.filter(item => item.properties.kind === "waypoint")).toHaveLength(0);
  });

  it("selects the rendered index and lets boundary-edit clicks add vertices", () => {
    mockBadgeCanvas();
    const props = {
      polygon: [] as MapPoint[], route, track: [] as MapPoint[], position: null,
      drawing: true, basemap: "satellite" as const, centerSignal: 0, fitSignal: 0,
      onWaypointSelect: vi.fn(), onMapClick: vi.fn(), onVertexMove: vi.fn()
    };
    const view = render(<GeoMap {...props}/>);
    stats.hit = 2;
    const click = stats.click as unknown as (event: object) => void;
    const point = { originalEvent: { defaultPrevented: false }, point: { x: 40, y: 40 },
      lngLat: { lat: origin.latitude, lng: origin.longitude } };
    click(point);
    expect(props.onWaypointSelect).toHaveBeenCalledWith(1);
    expect(props.onMapClick).not.toHaveBeenCalled();
    stats.hit = undefined;
    click(point);
    expect(props.onMapClick).toHaveBeenCalledWith(origin);
    props.onMapClick.mockClear();
    stats.hit = 2;
    view.rerender(<GeoMap {...props} selectedWaypoint={1} polygon={[origin]} editingBoundary/>);
    click(point);
    expect(props.onMapClick).toHaveBeenCalledWith(origin);
    expect(stats.data?.features.find(f => f.properties.selected)?.properties.index).toBe(2);
    props.onMapClick.mockClear();
    stats.pressVertex?.({ point: { x: 40, y: 40 }, features: [{ geometry: { type: "Point" }, properties: { kind: "vertex", index: 1 } }], preventDefault() {} });
    stats.release?.();
    click(point);
    expect(props.onMapClick).not.toHaveBeenCalled();
    click(point);
    expect(props.onMapClick).toHaveBeenCalledOnce();
  });

  it("follows fresh positions and reports a manual drag", () => {
    const props = {
      polygon: [], route: [], track: [], drawing: false, basemap: "grid" as const,
      centerSignal: 0, fitSignal: 0, follow: true,
      onFollowInterrupted: vi.fn(), onMapClick: vi.fn(), onVertexMove: vi.fn()
    };
    const view = render(<GeoMap {...props} position={origin}/>);
    view.rerender(<GeoMap {...props} position={null}/>);
    expect(stats.centers).toEqual([[origin.longitude, origin.latitude]]);
    view.rerender(<GeoMap {...props} position={route[1]}/>);
    expect(stats.centers.at(-1)).toEqual([route[1].longitude, route[1].latitude]);
    stats.drag?.();
    expect(props.onFollowInterrupted).toHaveBeenCalledOnce();
    view.rerender(<GeoMap {...props} follow={false} position={route[0]}/>);
    expect(stats.centers).toHaveLength(2);
  });

  it("fits the route with padding bounded by canvas width", () => {
    mockBadgeCanvas();
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
    expect(stats.fitPaddingLeft).toBe(380);
    view.rerender(<GeoMap {...props} fitSignal={2} fitLeftPadding={76}/>);
    expect(stats.fitPaddingLeft).toBe(76);
  });
});
