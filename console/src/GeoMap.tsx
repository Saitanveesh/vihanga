import { useEffect, useRef } from "react";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

export type MapPoint = { latitude: number; longitude: number };
export type RoutePoint = MapPoint & { altitude_m: number };

type Props = {
  polygon: MapPoint[];
  route: RoutePoint[];
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

function collection(polygon: MapPoint[], route: RoutePoint[], position: MapPoint | null) {
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
  polygon, route, position, drawing, basemap, centerSignal, fitSignal, onMapClick, onVertexMove
}: Props) {
  const mount = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const callback = useRef(onMapClick);
  const vertexCallback = useRef(onVertexMove);
  const geometryRef = useRef({polygon,route});
  geometryRef.current = {polygon,route};
  const data = useRef<any>(collection(polygon, route, position));
  const drawingRef = useRef(drawing);
  const movingVertex = useRef<number | null>(null);
  callback.current = onMapClick;
  vertexCallback.current = onVertexMove;
  data.current = collection(polygon, route, position);
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
      map.addLayer({ id: "route-line", type: "line", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "route"],
        paint: { "line-color": "#ffcf64", "line-width": 3 } });
      map.addLayer({ id: "vertices", type: "circle", source: "vihanga-geometry",
        filter: ["in", ["get", "kind"], ["literal", ["vertex", "waypoint"]]],
        paint: { "circle-radius": 5, "circle-color": "#f0faf7", "circle-stroke-color": "#153047",
          "circle-stroke-width": 1.5 } });
      map.addLayer({ id: "live-aircraft", type: "circle", source: "vihanga-geometry",
        filter: ["==", ["get", "kind"], "aircraft"],
        paint: { "circle-radius": 10, "circle-color": "#2ecbff", "circle-stroke-color": "#fff",
          "circle-stroke-width": 3 } });
    };
    map.on("style.load", install);
    map.on("mousedown", "vertices", event => {
      if (!drawingRef.current || !event.features?.length) return;
      const record = event.features[0].properties;
      if (record?.kind !== "vertex" || !Number.isInteger(record.index)) return;
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
    return () => { map.remove(); mapRef.current = null; };
    // One stable map instance. Style changes are applied by a separate effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (map) map.setStyle((basemap === "satellite" ? imagery : street) as any);
  }, [basemap]);

  useEffect(() => {
    const source = mapRef.current?.getSource("vihanga-geometry") as GeoJSONSource | undefined;
    if (source) source.setData(data.current);
  }, [polygon, route, position]);

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
