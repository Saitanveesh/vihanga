import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap, type Marker as MapLibreMarker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type MapPoint = { latitude: number; longitude: number };
export type RoutePoint = MapPoint & { altitude_m: number };

type Props = {
  polygon: MapPoint[];
  route: RoutePoint[];
  track: MapPoint[];
  position: MapPoint | null;
  drawing: boolean;
  basemap: "satellite" | "streets";
  centerSignal: number;
  fitSignal: number;
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

export function buildGeometry(polygon: MapPoint[], route: RoutePoint[], position: MapPoint | null, track: MapPoint[]) {
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
    features.push({ type: "Feature", properties: { kind: "waypoint", index: index + 1 },
      geometry: { type: "Point", coordinates: xy(p) } });
  }
  for (const [index, p] of polygon.entries()) {
    features.push({ type: "Feature", properties: { kind: "vertex", index: index + 1 },
      geometry: { type: "Point", coordinates: xy(p) } });
  }
  if (position) {
    features.push({ type: "Feature", properties: { kind: "aircraft" },
      geometry: { type: "Point", coordinates: xy(position) } });
  }
  return { type: "FeatureCollection", features };
}

export default function GeoMap({
  polygon, route, track, position, drawing, basemap, centerSignal, fitSignal, onMapClick, onVertexMove
}: Props) {
  const mount = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const pointMarkers = useRef<MapLibreMarker[]>([]);
  const currentBasemap = useRef(basemap);
  const callback = useRef(onMapClick);
  const vertexCallback = useRef(onVertexMove);
  const geometryRef = useRef({polygon,route});
  geometryRef.current = {polygon,route};
  const data = useRef<any>(buildGeometry(polygon, route, position, track));
  const drawingRef = useRef(drawing);
  const movingVertex = useRef<number | null>(null);
  callback.current = onMapClick;
  vertexCallback.current = onVertexMove;
  data.current = collection(polygon, route, position, track);
  drawingRef.current = drawing;

  useEffect(() => {
    if (!mount.current) return;
    const map = new maplibregl.Map({
      container: mount.current,
      style: (basemap === "satellite" ? imagery : street) as any,
      center: [77.5946, 12.9716], zoom: 12.4,
      attributionControl: { compact: true }
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), "top-right");
    const install = () => {
      if (map.getSource("vihanga-geometry")) return;
      map.addSource("vihanga-geometry", { type: "geojson", data: data.current });
      map.addLayer({ id: "survey-fill", type: "fill", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "survey"],
        paint: { "fill-color": "#31c88a", "fill-opacity": .27 } });
      map.addLayer({ id: "survey-boundary", type: "line", source: "vihanga-geometry",
        filter: ["in", ["get", "kind"], ["literal", ["survey", "outline"]]],
        paint: { "line-color": "#64e6aa", "line-width": 2 } });
      map.addLayer({ id: "observed-track", type: "line", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "observed_track"],
        paint: { "line-color": "#30b9ff", "line-width": 3,
                 "line-opacity": .84 } });
      map.addLayer({ id: "route-line", type: "line", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "route"],
        paint: { "line-color": "#ffcf64", "line-width": 3 } });
      map.addLayer({ id: "boundary-handles", type: "circle", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "vertex"],
        paint: { "circle-radius": 6, "circle-color": "#f7e9cd", "circle-stroke-color": "#284650",
          "circle-stroke-width": 2 } });
      map.addLayer({ id: "waypoint-dots", type: "circle", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "waypoint"],
        paint: { "circle-radius": 8, "circle-color": "#e6b25e",
                 "circle-stroke-color": "#13212b", "circle-stroke-width": 3 } });
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
    const firstFrame = window.requestAnimationFrame(resize);
    const secondFrame = window.setTimeout(resize, 160);
    map.on("mousedown", "boundary-handles", event => {
      if (!drawingRef.current || !event.features?.length) return;
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
    map.on("mouseup", release);
    map.on("mouseout", release);
    map.on("click", event => {
      if (event.originalEvent.defaultPrevented || movingVertex.current !== null) return;
      if (drawingRef.current) {
        callback.current({ latitude: +event.lngLat.lat.toFixed(8),
          longitude: +event.lngLat.lng.toFixed(8) });
      }
    });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.cancelAnimationFrame(firstFrame);
      window.clearTimeout(secondFrame);
      pointMarkers.current.forEach(marker => marker.remove());
      pointMarkers.current = [];
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
      map.setStyle((basemap === "satellite" ? imagery : street) as any);
    }
  }, [basemap]);

  useEffect(() => {
    const source = mapRef.current?.getSource("vihanga-geometry") as GeoJSONSource | undefined;
    if (source) source.setData(data.current);
  }, [polygon, route, position, track]);

  useEffect(() => {
    pointMarkers.current.forEach(marker => marker.remove());
    pointMarkers.current = [];
    const map = mapRef.current;
    if (!map) return;

    // HTML overlay pins remain visible on both satellite and street layers,
    // including during style reloads. All points receive an actual marker;
    // large coverage missions abbreviate labels to prevent visual clutter.
    const stride = Math.max(1, Math.ceil(route.length / 35));
    route.forEach((point, index) => {
      const node = document.createElement("div");
      const numbered = route.length <= 35 || index === 0 ||
        index === route.length - 1 || index % stride === 0;
      node.className = "vihanga-waypoint" + (numbered ? "" : " compact");
      node.textContent = numbered ? String(index + 1) : "";
      node.setAttribute("aria-label", "Waypoint " + (index + 1));
      node.title = "WP " + (index + 1) + " · " +
        point.latitude.toFixed(6) + ", " + point.longitude.toFixed(6);
      node.addEventListener("click", event => event.stopPropagation());
      const marker = new maplibregl.Marker({element: node, anchor: "center"})
        .setLngLat([point.longitude, point.latitude]).addTo(map);
      pointMarkers.current.push(marker);
    });
    return () => {
      pointMarkers.current.forEach(marker => marker.remove());
      pointMarkers.current = [];
    };
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && position && centerSignal > 0) {
      map.flyTo({ center: [position.longitude, position.latitude], zoom: 17, essential: true });
    }
    // Camera is recentered only by an explicit operator action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centerSignal]);

  useEffect(() => {
    const map = mapRef.current;
    const points = [...geometryRef.current.polygon, ...geometryRef.current.route];
    if (!map || fitSignal <= 0 || points.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    points.forEach(p => bounds.extend([p.longitude,p.latitude]));
    if (points.length === 1) {
      map.flyTo({center:[points[0].longitude,points[0].latitude],zoom:17});
    } else {
      map.fitBounds(bounds, {padding:{top:105,bottom:130,left:440,right:100},maxZoom:19,duration:650});
    }
  }, [fitSignal]);

  return <div ref={mount} className={drawing ? "map-canvas drawing" : "map-canvas"}
    role="application" aria-label="Geographic map: select draw mode and click to add polygon vertices or waypoints"/>;
}
