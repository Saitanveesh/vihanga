import { useEffect, useRef, useState } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type MapPoint = { latitude: number; longitude: number };
export type RoutePoint = MapPoint & { altitude_m: number };

type Props = {
  polygon: MapPoint[];
  route: RoutePoint[];
  track: MapPoint[];
  position: MapPoint | null;
  drawing: boolean;
  editingBoundary?: boolean;
  basemap: "satellite" | "streets" | "grid";
  centerSignal: number;
  fitSignal: number;
  follow?: boolean;
  onFollowInterrupted?: () => void;
  selectedWaypoint?: number | null;
  onWaypointSelect?: (index: number) => void;
  fitLeftPadding?: number;
  onMapClick: (point: MapPoint) => void;
  onVertexMove: (index: number, point: MapPoint) => void;
};

const street = {
  version: 8,
  sources: {
    tiles: {
      type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256,
      attribution: "© OpenStreetMap contributors"
    }
  },
  layers: [{ id: "base", type: "raster", source: "tiles" }]
};
const imagery = {
  version: 8,
  sources: {
    tiles: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: "Tiles © Esri; imagery © Esri, Maxar, Earthstar Geographics, GIS User Community"
    }
  },
  layers: [{ id: "base", type: "raster", source: "tiles" }]
};
const basemaps = {
  satellite: imagery,
  streets: street,
  grid: { version: 8, sources: {}, layers: [] }
};

export function buildGeometry(polygon: MapPoint[], route: RoutePoint[], position: MapPoint | null,
                              track: MapPoint[], selectedWaypoint: number | null = null) {
  const features: any[] = [];
  const xy = (point: MapPoint) => [point.longitude, point.latitude];
  if (polygon.length >= 3) {
    features.push({ type: "Feature", properties: { kind: "survey" },
      geometry: { type: "Polygon", coordinates: [[...polygon.map(xy), xy(polygon[0])]] } });
  }
  if (polygon.length >= 2) {
    features.push({ type: "Feature", properties: { kind: "outline" },
      geometry: { type: "LineString", coordinates: polygon.map(xy) } });
  }
  if (track.length >= 2) {
    features.push({type: "Feature", properties:{kind:"observed_track"},
      geometry:{type:"LineString",coordinates:track.map(xy)}});
  }
  if (route.length >= 2) {
    features.push({ type: "Feature", properties: { kind: "route" },
      geometry: { type: "LineString", coordinates: route.map(xy) } });
  }
  for (const [index, p] of route.entries()) {
    features.push({ type: "Feature", properties: {
      kind: "waypoint", index: index + 1, selected: index === selectedWaypoint,
      pin_priority: index === 0 ? 0 : index === route.length - 1 ? 1 : index + 2
    }, geometry: { type: "Point", coordinates: xy(p) } });
  }
  for (const [index, p] of polygon.entries()) {
    features.push({ type: "Feature", properties: { kind: "vertex", index: index + 1 },
      geometry: { type: "Point", coordinates: xy(p) } });
  }
  if (position) {
    features.push({ type: "Feature", properties: { kind: "aircraft" },
      geometry: { type: "Point", coordinates: xy(position) } });
  }
  return { type: "FeatureCollection" as const, features };
}

const WAYPOINT_LAYERS = ["waypoint-selected", "waypoint-numbers", "waypoint-points"];

function installWaypointBadges(map: MapLibreMap, count: number) {
  // Bake local labels into the style so both dots and numbers share the line's
  // map projection. Satellite, street and offline modes need no glyph server.
  const available = Math.min(count, 200);
  if (!available || map.hasImage("wp-" + available)) return;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.font = "700 24px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let index = 1; index <= available; index++) {
    const id = "wp-" + index;
    if (map.hasImage(id)) continue;
    context.clearRect(0, 0, 64, 64);
    context.beginPath();
    context.arc(32, 32, 25, 0, Math.PI * 2);
    context.fillStyle = "#ffca72";
    context.fill();
    context.lineWidth = 5;
    context.strokeStyle = "#131d28";
    context.stroke();
    context.fillStyle = "#131d28";
    context.fillText(String(index), 32, 33);
    map.addImage(id, context.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
  }
}

export default function GeoMap({
  polygon, route, track, position, drawing, editingBoundary = false, basemap, centerSignal, fitSignal,
  selectedWaypoint = null, onWaypointSelect, fitLeftPadding = 120, follow = false, onFollowInterrupted,
  onMapClick, onVertexMove
}: Props) {
  const [mapUnavailable, setMapUnavailable] = useState(false);
  const mount = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const currentBasemap = useRef(basemap);
  const callback = useRef(onMapClick);
  const vertexCallback = useRef(onVertexMove);
  const waypointCallback = useRef(onWaypointSelect);
  const followInterrupt = useRef(onFollowInterrupted);
  const geometryRef = useRef({polygon,route});
  geometryRef.current = {polygon,route};
  const data = useRef(buildGeometry(polygon, route, position, track, selectedWaypoint));
  const drawingRef = useRef(drawing);
  const editBoundaryRef = useRef(editingBoundary);
  const movingVertex = useRef<number | null>(null);
  callback.current = onMapClick;
  vertexCallback.current = onVertexMove;
  waypointCallback.current = onWaypointSelect;
  followInterrupt.current = onFollowInterrupted;
  data.current = buildGeometry(polygon, route, position, track, selectedWaypoint);
  drawingRef.current = drawing;
  editBoundaryRef.current = editingBoundary;

  useEffect(() => {
    if (!mount.current) return;
    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: mount.current,
        style: basemaps[basemap] as any,
        center: [77.5946, 12.9716], zoom: 12.4,
        attributionControl: { compact: true }
      });
    } catch {
      setMapUnavailable(true);
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    const install = () => {
      if (map.getSource("vihanga-geometry")) return;
      installWaypointBadges(map, geometryRef.current.route.length);
      map.addSource("vihanga-geometry", { type: "geojson", data: data.current, tolerance: 0 });
      map.addLayer({ id: "survey-fill", type: "fill", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "survey"],
        paint: { "fill-color": "#318858", "fill-opacity": .26 } });
      map.addLayer({ id: "survey-boundary", type: "line", source: "vihanga-geometry",
        filter: ["in", ["get", "kind"], ["literal", ["survey", "outline"]]],
        paint: { "line-color": "#cde8ce", "line-width": 2.8, "line-opacity": .97 } });
      map.addLayer({ id: "observed-track", type: "line", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "observed_track"],
        paint: { "line-color": "#30b9ff", "line-width": 3,
                 "line-opacity": .84 } });
      map.addLayer({ id: "route-line", type: "line", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "route"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffca72", "line-width": 3.4, "line-opacity": .94 } });
      map.addLayer({ id: "waypoint-points", type: "circle", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "waypoint"],
        paint: {
          "circle-radius": ["case", ["boolean", ["get", "selected"], false], 15, 3],
          "circle-color": "#ffca72", "circle-stroke-color": "#131d28", "circle-stroke-width": 1.5
        } });
      map.addLayer({ id: "waypoint-numbers", type: "symbol", source: "vihanga-geometry",
        filter: ["all", ["==", ["get", "kind"], "waypoint"], ["<=", ["get", "index"], 200],
          ["==", ["get", "selected"], false]],
        layout: {
          "icon-image": ["concat", "wp-", ["to-string", ["get", "index"]]],
          "icon-padding": 3, "symbol-sort-key": ["get", "pin_priority"]
        }
      });
      map.addLayer({ id: "waypoint-selected", type: "symbol", source: "vihanga-geometry",
        filter: ["all", ["==", ["get", "kind"], "waypoint"], ["<=", ["get", "index"], 200],
          ["==", ["get", "selected"], true]],
        layout: {
          "icon-image": ["concat", "wp-", ["to-string", ["get", "index"]]],
          "icon-allow-overlap": true
        }
      });
      map.addLayer({ id: "boundary-handles", type: "circle", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "vertex"],
        paint: { "circle-radius": 6, "circle-color": "#f7e9cd", "circle-stroke-color": "#284650",
          "circle-stroke-width": 2 } });
      map.addLayer({ id: "live-aircraft", type: "circle", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "aircraft"],
        paint: { "circle-radius": 10, "circle-color": "#2ecbff", "circle-stroke-color": "#fff",
          "circle-stroke-width": 3 } });
    };
    map.on("style.load", install);
    if (map.isStyleLoaded()) install();

    // The map stage can grow after first React paint or after a sidebar
    // collapses. Without resize(), WebGL retains the previous canvas size,
    // leaving an empty stripe at the right/bottom of the map.
    const resize = () => { if (mapRef.current === map) map.resize(); };
    const observer = typeof ResizeObserver === "undefined" ? null :
      new ResizeObserver(resize);
    observer?.observe(mount.current);
    window.addEventListener("resize", resize);
    map.on("load", resize);
    const firstFrame = window.requestAnimationFrame?.(resize);
    const secondFrame = window.setTimeout(resize, 160);
    map.on("mousedown", "boundary-handles", event => {
      if (!editBoundaryRef.current || !event.features?.length) return;
      const record = event.features[0].properties;
      if (record?.kind !== "vertex" || !Number.isInteger(Number(record.index))) return;
      movingVertex.current = Number(record.index) - 1;
      map.dragPan.disable();
      event.preventDefault();
    });
    map.on("mousemove", event => {
      if (movingVertex.current === null) return;
      vertexCallback.current(movingVertex.current, {
        latitude: +event.lngLat.lat.toFixed(8),
        longitude: +event.lngLat.lng.toFixed(8)
      });
    });
    const release = () => {
      if (movingVertex.current !== null) {
        movingVertex.current = null;
        map.dragPan.enable();
      }
    };
    map.on("dragstart", () => followInterrupt.current?.());
    map.on("mouseup", release);
    map.on("mouseout", release);
    map.on("click", event => {
      if (event.originalEvent.defaultPrevented || movingVertex.current !== null) return;
      if (!editBoundaryRef.current && waypointCallback.current) {
        const layers = WAYPOINT_LAYERS.filter(id => map.getLayer(id));
        const pin = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
        const index = Number(pin?.properties?.index);
        if (Number.isInteger(index) && index >= 1 && index <= geometryRef.current.route.length) {
          waypointCallback.current(index - 1);
          return;
        }
      }
      if (drawingRef.current) {
        callback.current({ latitude: +event.lngLat.lat.toFixed(8),
          longitude: +event.lngLat.lng.toFixed(8) });
      }
    });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      if (firstFrame !== undefined) window.cancelAnimationFrame?.(firstFrame);
      window.clearTimeout(secondFrame);
      map.remove();
      mapRef.current = null;
    };
    // One stable map instance. Style changes are applied by a separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map && currentBasemap.current !== basemap) {
      currentBasemap.current = basemap;
      map.setStyle(basemaps[basemap] as any);
    }
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource("vihanga-geometry") as GeoJSONSource | undefined;
    if (map && source) {
      installWaypointBadges(map, route.length);
      source.setData(data.current);
    }
  }, [polygon, route, position, track, selectedWaypoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && position && centerSignal > 0) {
      map.flyTo({ center: [position.longitude, position.latitude], zoom: 17, essential: true });
    }
    // The center button runs only when its signal changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerSignal]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && follow && position) map.jumpTo({ center: [position.longitude, position.latitude] });
  }, [follow, position]);

  useEffect(() => {
    const map = mapRef.current;
    const points = [...geometryRef.current.polygon, ...geometryRef.current.route];
    if (!map || fitSignal <= 0 || points.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    points.forEach(p => bounds.extend([p.longitude,p.latitude]));
    if (points.length === 1) {
      map.flyTo({center:[points[0].longitude,points[0].latitude],zoom:17});
    } else {
      const mapWidth = mount.current?.clientWidth || 1000;
      const left = Math.max(36, Math.min(fitLeftPadding, Math.floor(mapWidth * .38)));
      map.fitBounds(bounds, {
        padding: {top:90,bottom:110,left,right:64},maxZoom:19,duration:650
      });
    }
  }, [fitSignal, fitLeftPadding]);

  return <>
    <div ref={mount} className={drawing ? "map-canvas drawing" : "map-canvas"}
      role="application" aria-label="Geographic map: select draw mode and click to add polygon vertices or waypoints"/>
    {mapUnavailable && <div className="station-map-error" role="status">
      Map unavailable. Enable WebGL and reload to use the map.
    </div>}
  </>;
}
