import { lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { MapPoint } from "./GeoMap";
import PanelLoader from "./PanelLoader";
import FlightInstruments from "./FlightInstruments";
import { currentTelemetry, finite, type FlightPoint } from "./flightHistory";
import useDisplayTelemetry from "./useDisplayTelemetry";
import NetworkWatch from "./NetworkWatch";
import { useStationBoot, type BootData } from "./StationBoot";
import { BrowserSerialReceiver } from "./BrowserSerial";
import type { ConnectionRequest, ConnectionRole } from "./ConnectionSettings";
import UiIcon, { type IconName } from "./UiIcon";
import {
  connectBroker, connectCloud, connectLAN, connectUDP, connectTCP, connectSerial, disconnectLink,
  connectBackupBroker, connectBackupCloud, connectBackupLAN, connectBackupSerial, connectBackupUDP, connectBackupTCP,
  activateTelemetrySource, disconnectBackup, getMissions,
  getOperatorCatalog, getParameterReadback, sendBenchRead,
  getFleetTelemetry, getObservedTrack, getVehicles, previewSurvey, previewCircularSurvey, registerVehicle, saveMission,
  type Mission, type SurveyPreview, type Telemetry,
  type Vehicle, type VehicleCreate, type Waypoint,
  type BenchReadKind, type OperatorCatalog, type ParameterReadback
} from "./api";

type Section = "FLIGHT" | "CONTROL" | "PLAN" | "FLEET" | "LINK" | "BENCH" | "HISTORY" | "VIDEO";
const loadGeoMap = () => import("./GeoMap");
const GeoMap = lazy(loadGeoMap);
const Bench = lazy(() => import("./Bench"));
const ControlPanel = lazy(() => import("./ControlPanel"));
const OperationsPanel = lazy(() => import("./OperationsPanel"));
const ConnectionSettings = lazy(() => import("./ConnectionSettings"));
const sectionTitles: Record<Section, string> = {
  FLIGHT: "Flight monitoring", CONTROL: "Aircraft controls", PLAN: "Mission planning",
  FLEET: "Aircraft directory", LINK: "Link health", BENCH: "Bench", HISTORY: "Mission drafts", VIDEO: "Live video"
};
const VIEWER_SILENCE_MS = 4000;
const AIRCRAFT_PREFERENCE = "vihanga.station.aircraft";
const BASEMAP_PREFERENCE = "vihanga.station.basemap";
type Basemap = "satellite" | "streets" | "grid";
type DrawMode = "NONE" | "POLYGON" | "WAYPOINT";
const EMPTY_POLYGON: MapPoint[] = [];
const EMPTY_ROUTE: Waypoint[] = [];
const EMPTY_TRACK: MapPoint[] = [];
const primarySections: { label: Section; icon: IconName }[] = [
  { label: "FLIGHT", icon: "flight" }, { label: "CONTROL", icon: "shield" }, { label: "PLAN", icon: "plan" },
  { label: "VIDEO", icon: "video" }
];

function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key); }
  catch { return null; }
}
function savePreference(key: string, value: string) {
  try { window.localStorage.setItem(key, value); }
  catch { /* Workspace remains usable with storage disabled. */ }
}
function initialBasemap(): Basemap {
  const stored = readPreference(BASEMAP_PREFERENCE);
  return stored === "grid" || stored === "streets" ? stored : "satellite";
}

function privateCameraUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".ts.net")
      && !url.username && !url.password && !url.search && !url.hash
      && (url.port === "" || url.port === "443" || url.port === "8443");
  } catch { return false; }
}
function restoredCameras(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem("vihanga.camera.pages.v1") || "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter(([id, url]) =>
      /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(id) &&
      typeof url === "string" && privateCameraUrl(url)
    ));
  } catch { return {}; }
}

function linkLabel(status?: string) {
  return status === "LIVE" ? "LIVE TELEMETRY" :
    status === "PARTIAL" ? "PARTIAL TELEMETRY" :
    status === "STALE" ? "STALE DATA" :
    status === "CONNECTING" ? "CONNECTING" :
    status === "RECONNECTING" ? "RECONNECTING" :
    status === "WAITING_FOR_FRAMES" ? "AWAITING MAVLINK" :
    status === "ERROR" ? "LINK ERROR" : "OFFLINE";
}
const initialVehicle: VehicleCreate = {
  vehicle_id: "", label: "", autopilot: "ARDUPILOT", interface: "UART"
};

export default function App({ account, onInitialChecksComplete }: {
  onInitialChecksComplete?: () => void;
  account?: { name: string; role: "admin" | "operator" | "viewer"; signOut: () => void };
} = {}) {
  const [section, setSection] = useState<Section>("FLIGHT");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState("");
  const [readings, setReadings] = useState<Record<string, Telemetry>>({});
  const viewerReceipt = useRef<{ id: string; at: number } | null>(null);
  const [observedTrack, setObservedTrack] = useState(EMPTY_TRACK);
  const [liveTransportConnected, setLiveTransportConnected] = useState(false);
  const [alert, setAlert] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>(initialBasemap);
  const [centerSignal, setCenterSignal] = useState(0);
  const [followedAircraftId, setFollowedAircraftId] = useState("");
  const followAircraft = Boolean(selected && followedAircraftId === selected);
  const stopFollowing = useCallback(() => setFollowedAircraftId(""), []);
  useEffect(stopFollowing, [selected, stopFollowing]);
  useEffect(() => { void loadGeoMap().catch(() => {}); }, []);

  const [vehicleForm, setVehicleForm] = useState<VehicleCreate>(initialVehicle);
  const [drawMode, setDrawMode] = useState<DrawMode>("NONE");
  const [polygon, setPolygon] = useState<MapPoint[]>([]);
  const [manual, setManual] = useState<Waypoint[]>([]);
  const [survey, setSurvey] = useState<SurveyPreview | null>(null);
  const previewRevision = useRef(0);
  const [pattern, setPattern] = useState<"PARALLEL" | "CIRCULAR">("PARALLEL");
  const [speed, setSpeed] = useState(5);
  const [editedRoute, setEditedRoute] = useState<Waypoint[] | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [selectedWaypoint, setSelectedWaypoint] = useState<number | null>(null);
  const [aircraftSearch, setAircraftSearch] = useState("");
  const [aircraftFilter, setAircraftFilter] = useState<"ALL" | "LIVE" | "OFFLINE">("ALL");
  const [spacing, setSpacing] = useState(20);
  const [bearing, setBearing] = useState(0);
  const [altitude, setAltitude] = useState(35);
  const [missionTitle, setMissionTitle] = useState("");
  const [openedMission, setOpenedMission] = useState<Mission | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [operatorCatalog, setOperatorCatalog] = useState<OperatorCatalog | null>(null);
  const [parameterReadback, setParameterReadback] = useState<ParameterReadback | null>(null);
  const [connectionRole, setConnectionRole] = useState<ConnectionRole>("PRIMARY");
  const [connectionError, setConnectionError] = useState("");
  const browserSerialRef = useRef<BrowserSerialReceiver | null>(null);
  const [browserSerialAircraft, setBrowserSerialAircraft] = useState("");
  const [browserSerialSample, setBrowserSerialSample] = useState<Telemetry | null>(null);
  const [browserSerialSelected, setBrowserSerialSelected] = useState(false);
  const [browserAutoSelect, setBrowserAutoSelect] = useState(false);
  useEffect(() => () => { void browserSerialRef.current?.stop(); }, []);
  useEffect(() => {
    if (browserSerialAircraft && browserSerialAircraft !== selected) {
      void browserSerialRef.current?.stop();
      browserSerialRef.current = null;
      setBrowserSerialAircraft("");
      setBrowserSerialSample(null);
      setBrowserSerialSelected(false);
    }
  }, [selected, browserSerialAircraft]);
  useEffect(() => {
    if (browserAutoSelect && browserSerialAircraft === selected &&
        browserSerialSample?.status === "LIVE") {
      setBrowserSerialSelected(true);
      setBrowserAutoSelect(false);
      setObservedTrack([]);
    }
  }, [browserAutoSelect, browserSerialAircraft, selected, browserSerialSample?.status]);

  const [cameraInput, setCameraInput] = useState("");
  const [cameraPages, setCameraPages] = useState<Record<string, string>>(restoredCameras);
  useEffect(() => { setCameraInput(cameraPages[selected] ?? ""); }, [selected]);

  const applyBootData = useCallback(({ vehicles: nextVehicles, missions: nextMissions }: BootData) => {
    if (nextVehicles) {
      const previousAircraft = readPreference(AIRCRAFT_PREFERENCE);
      setVehicles(nextVehicles);
      setSelected(prev => {
        const preferred = prev || previousAircraft;
        return nextVehicles.find(vehicle => vehicle.vehicle_id === preferred)?.vehicle_id ?? nextVehicles[0]?.vehicle_id ?? "";
      });
    }
    if (nextMissions) setMissions(nextMissions);
  }, []);
  const boot = useStationBoot(applyBootData);
  useEffect(() => {
    if (boot.initialized) onInitialChecksComplete?.();
  }, [boot.initialized, onInitialChecksComplete]);
  useEffect(() => { if (selected) savePreference(AIRCRAFT_PREFERENCE, selected); }, [selected]);
  useEffect(() => savePreference(BASEMAP_PREFERENCE, basemap), [basemap]);

  async function refresh() {
    try {
      const [nextVehicles, nextMissions] = await Promise.all([getVehicles(), getMissions()]);
      applyBootData({ vehicles: nextVehicles, missions: nextMissions });
    } catch (e) {
      setAlert(e instanceof Error ? e.message : String(e));
    }
  }

  const fleetInterval = liveTransportConnected && !fleetOpen && section !== "FLEET" ? 5000 : 1600;
  useEffect(() => {
    if (vehicles.length === 0) { setReadings({}); return; }
    let mounted = true;
    let pending: AbortController | null = null;
    function applyFleet(next: Record<string, Telemetry>) {
      const receipt = viewerReceipt.current;
      const viewerId = receipt && performance.now() - receipt.at < VIEWER_SILENCE_MS ? receipt.id : "";
      setReadings(previous => viewerId && previous[viewerId] ? { ...next, [viewerId]: previous[viewerId] } : next);
    }
    async function poll() {
      if (pending || document.hidden) return;
      const controller = new AbortController();
      pending = controller;
      const deadline = window.setTimeout(() => controller.abort(), 2800);
      try {
        const next = await getFleetTelemetry(controller.signal);
        if (mounted) applyFleet(next);
      } catch {
        if (mounted) applyFleet({});
      } finally {
        window.clearTimeout(deadline);
        pending = null;
      }
    }
    void poll();
    const handle = window.setInterval(poll, fleetInterval);
    document.addEventListener("visibilitychange", poll);
    return () => {
      mounted = false;
      pending?.abort();
      window.clearInterval(handle);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [vehicles.length, fleetInterval]);


  // Low-latency local viewer; the backend streams only real FC-derived state.
  // A separate fleet poll remains as a bounded fallback for disconnected clients.
  useEffect(() => {
    if (!selected) { setLiveTransportConnected(false); return; }
    let stopped = false;
    let retry: number | undefined;
    let ws: WebSocket | null = null;
    let lastActivity = performance.now();
    let failures = 0;
    function open() {
      const openedAt = performance.now();
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const path = "/ws/v1/telemetry/" + encodeURIComponent(selected);
      const socket = new WebSocket(protocol + "//" + window.location.host + path);
      ws = socket;
      lastActivity = performance.now();
      socket.onmessage = event => {
        if (stopped) return;
        try {
          const sample = JSON.parse(String(event.data)) as Telemetry;
          if (sample.vehicle_id === selected && typeof sample.status === "string" &&
              typeof sample.heartbeat_fresh === "boolean" && typeof sample.attitude_fresh === "boolean") {
            lastActivity = performance.now();
            viewerReceipt.current = { id: selected, at: lastActivity };
            setLiveTransportConnected(true);
            setReadings(previous => ({ ...previous, [selected]: sample }));
          }
        } catch { /* ignore malformed local frame; do not display it */ }
      };
      socket.onclose = event => {
        if (stopped) return;
        ws = null;
        viewerReceipt.current = null;
        setLiveTransportConnected(false);
        if (event.code === 1008 || event.code === 4404) return;
        const stable = performance.now() - openedAt >= 15_000 && performance.now() - lastActivity < VIEWER_SILENCE_MS;
        failures = stable ? 0 : Math.min(failures + 1, 5);
        retry = window.setTimeout(open, Math.min(20_000, 800 * 2 ** failures * (.8 + Math.random() * .4)));
      };
      socket.onerror = () => socket.close();
    }
    open();
    const watchdog = window.setInterval(() => {
      if (ws && performance.now() - lastActivity > VIEWER_SILENCE_MS) {
        if (viewerReceipt.current?.id === selected) {
          setReadings(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== selected)));
        }
        viewerReceipt.current = null;
        setLiveTransportConnected(false);
        ws.close();
      }
    }, 500);
    return () => {
      stopped = true;
      viewerReceipt.current = null;
      window.clearInterval(watchdog);
      if (retry !== undefined) window.clearTimeout(retry);
      ws?.close();
      setLiveTransportConnected(false);
    };
  }, [selected]);

  const mapVisible = section !== "BENCH";
  useEffect(() => setObservedTrack(EMPTY_TRACK), [selected]);
  useEffect(() => {
    if (!selected || !mapVisible) return;
    let stopped = false;
    let pending: AbortController | null = null;
    async function refreshTrack() {
      if (pending || document.hidden) return;
      const controller = new AbortController();
      pending = controller;
      const deadline = window.setTimeout(() => controller.abort(), 2500);
      try {
        const result = await getObservedTrack(selected, controller.signal);
        if (!stopped) {
          const points = result.points;
          setObservedTrack(previous => previous.length === points.length && previous.every((point, index) =>
            point.latitude === points[index].latitude && point.longitude === points[index].longitude)
            ? previous : points);
        }
      } catch {
        if (!stopped) setObservedTrack(EMPTY_TRACK);
      } finally {
        window.clearTimeout(deadline);
        pending = null;
      }
    }
    void refreshTrack();
    const timer = window.setInterval(refreshTrack, 2800);
    document.addEventListener("visibilitychange", refreshTrack);
    return () => {
      stopped = true;
      pending?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshTrack);
    };
  }, [selected, mapVisible]);

  const active = vehicles.find(v => v.vehicle_id === selected);
  const primarySample = readings[selected];
  const localBrowserSample = browserSerialAircraft === selected ? browserSerialSample : null;
  const sample = useMemo(() => localBrowserSample && browserSerialSelected
    ? {...localBrowserSample,
       active_source:"BACKUP" as const,
       primary_status:primarySample?.status || "OFFLINE",
       primary_transport:primarySample?.transport || null}
    : primarySample && localBrowserSample
    ? {...primarySample,
       backup_status:localBrowserSample.status,
       backup_transport:"BROWSER_SERIAL_READ_ONLY",
       backup_heartbeat_fresh:localBrowserSample.heartbeat_fresh,
       backup_attitude_fresh:localBrowserSample.attitude_fresh,
       backup_frame_rate_5s_hz:localBrowserSample.frame_rate_5s_hz,
       backup_age_ms:localBrowserSample.age_ms}
    : primarySample, [browserSerialSelected, localBrowserSample, primarySample]);
  const activeTelemetry = useDisplayTelemetry(browserSerialSelected ? localBrowserSample ?? primarySample : primarySample);
  const displaySample = sample && activeTelemetry && activeTelemetry.status !== sample.status
    ? { ...sample, status: activeTelemetry.status, heartbeat_fresh: false, attitude_fresh: false } : sample;
  const controlsVisible = panelOpen && section === "CONTROL";
  useEffect(() => {
    if (!selected || !controlsVisible) {
      setOperatorCatalog(null);
      setParameterReadback(null);
      return;
    }
    let cancelled = false;
    getOperatorCatalog(selected).then(result => {
      if (!cancelled) setOperatorCatalog(result);
    }).catch(() => { if (!cancelled) setOperatorCatalog(null); });
    return () => { cancelled = true; };
  }, [selected, controlsVisible, sample?.transport, sample?.status, sample?.active_source]);
  useEffect(() => {
    setParameterReadback(null);
    if (!selected || !controlsVisible) return;
    let cancelled = false;
    getParameterReadback(selected).then(result => {
      if (!cancelled) setParameterReadback(result);
    }).catch(() => { if (!cancelled) setParameterReadback(null); });
    return () => { cancelled = true; };
  }, [selected, controlsVisible, sample?.transport, sample?.active_source]);
  const cameraUrl = cameraPages[selected] ?? "";
  const current = currentTelemetry(displaySample);
  const [reviewPoint, setReviewPoint] = useState<FlightPoint | null>(null);
  const latitude = finite(current?.latitude);
  const longitude = finite(current?.longitude);
  const location = useMemo(() => latitude != null && longitude != null &&
    Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null, [latitude, longitude]);
  const waypoints = openedMission?.waypoints ?? editedRoute ?? survey?.waypoints ?? manual;
  function aircraftStatus(vehicleId: string): string | undefined {
    return browserSerialSelected && browserSerialAircraft === vehicleId
      ? browserSerialSample?.status : readings[vehicleId]?.status;
  }
  const fleetMatches = vehicles.filter(v => {
    const q = aircraftSearch.trim().toLowerCase();
    const match = !q || v.label.toLowerCase().includes(q) || v.vehicle_id.toLowerCase().includes(q);
    const status = aircraftStatus(v.vehicle_id);
    return match && (aircraftFilter === "ALL" || (aircraftFilter === "LIVE" ? status === "LIVE" : status !== "LIVE"));
  });
  const displayedMissionList = missions.filter(m => m.vehicle_id === selected);
  const liveCount = useMemo(() => {
    const statuses = new Map(Object.entries(readings).map(([id, item]) => [id, item.status]));
    if (browserSerialSelected && browserSerialAircraft)
      statuses.set(browserSerialAircraft, browserSerialSample?.status || "OFFLINE");
    return Array.from(statuses.values()).filter(value => value === "LIVE").length;
  }, [readings, browserSerialSelected, browserSerialAircraft, browserSerialSample?.status]);

  function notify(text: string) { setNotice(text); setAlert(""); }
  function fail(error: unknown) {
    setNotice("");
    setAlert(error instanceof Error ? error.message : String(error));
  }
  function clearPreview() {
    previewRevision.current += 1;
    setSurvey(null);
    setEditedRoute(null);
    setSelectedWaypoint(null);
  }
  const [cameraExpanded, setCameraExpanded] = useState(false);

  function navigate(page: Section) {
    setCameraExpanded(false);
    if (page !== "FLIGHT") stopFollowing();
    previewRevision.current += 1;
    setSelectedWaypoint(null);
    setPanelOpen(page !== "FLIGHT");
    setSection(page);
    setDrawMode("NONE");
    setAlert(""); setNotice("");
  }
  function startDrawing(mode: "POLYGON" | "WAYPOINT") {
    previewRevision.current += 1;
    setDrawMode(mode);
    if (window.matchMedia?.("(max-width: 700px)").matches) setPanelOpen(false);
  }

  function clicked(point: MapPoint) {
    if (section !== "PLAN" || drawMode === "NONE") return;
    setOpenedMission(null);
    clearPreview();
    if (drawMode === "POLYGON") {
      setPolygon(old => [...old, point]);
    }
    if (drawMode === "WAYPOINT") {
      const route = [...waypoints, { ...point, altitude_m: altitude }];
      setManual(route);
      setSelectedWaypoint(route.length - 1);
    }
  }


  function clearWaypoints() {
    // A saved route is immutable in the database. Clearing only changes the
    // on-screen draft and its visible map geometry, not saved mission records.
    setOpenedMission(null);
    setManual([]);
    clearPreview();
    notify("Waypoint layer cleared.");
  }

  function clearBoundary() {
    setPolygon([]);
    if (survey) clearPreview();
    setSelectedWaypoint(null);
    startDrawing("POLYGON");
    notify("Click the map to start the next boundary.");
  }

  function resetPlanner() {
    setPolygon([]);
    setManual([]);
    clearPreview();
    setOpenedMission(null);
    startDrawing("POLYGON");
    setPattern("PARALLEL");
    setSpacing(20);
    setBearing(0);
    setAltitude(35);
    setSpeed(5);
    setMissionTitle("");
    notify("Planner reset. Click the map to start a boundary.");
  }

  function undoPlannerPoint() {
    if (openedMission) return;
    if (drawMode === "POLYGON") {
      setPolygon(previous => previous.slice(0, -1));
      clearPreview();
    } else {
      if (survey?.pattern === "CIRCULAR") return;
      previewRevision.current += 1;
      const previous = editedRoute ?? survey?.waypoints ?? manual;
      if (survey || editedRoute) setEditedRoute(previous.slice(0, -1));
      else setManual(points => points.slice(0, -1));
    }
    setSelectedWaypoint(null);
  }

  function reviseWaypoint(index: number, field: "latitude" | "longitude" | "altitude_m", raw: string) {
    if (openedMission || (survey?.pattern === "CIRCULAR" && field !== "altitude_m")) return;
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    if ((field === "latitude" && Math.abs(n) > 90) ||
        (field === "longitude" && Math.abs(n) > 180) ||
        (field === "altitude_m" && (n < 0 || n > 120))) return;
    previewRevision.current += 1;
    setEditedRoute(previous => (previous ?? (survey?.waypoints ?? manual)).map((p,i) =>
      i === index ? { ...p, [field]: n } : p
    ));
  }

  function exportDraftGeoJSON() {
    if (waypoints.length < 2) return fail(new Error("No route available to export"));
    const data = {
      type: "FeatureCollection", features: [{
        type: "Feature",
        properties: {
          vehicle_id: selected || null, status: "DRAFT_ONLY",
          warning: "Not airspace, obstacle, terrain or aircraft validated",
          altitude_m: "altitude stored per point"
        },
        geometry: { type: "LineString", coordinates: waypoints.map(p => [
          p.longitude, p.latitude, p.altitude_m
        ]) }
      }]
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:"application/geo+json"}));
    const a = document.createElement("a");
    a.href = url;
    a.download = "vihanga-" + (selected || "draft") + "-route.geojson";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
    notify("Offline GeoJSON route exported. No vehicle upload performed.");
  }

  function moveVertex(index: number, point: MapPoint) {
    if (section !== "PLAN" || drawMode !== "POLYGON" || openedMission) return;
    setPolygon(p => p.map((v,i) => i === index ? point : v));
    clearPreview();
  }

  async function addAircraft(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await registerVehicle({
        ...vehicleForm, vehicle_id: vehicleForm.vehicle_id.trim().toUpperCase(),
        label: vehicleForm.label.trim()
      });
      setVehicleForm(initialVehicle);
      await refresh();
      notify("Aircraft registered. It remains OFFLINE until a real link is established.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function preview() {
    const revision = ++previewRevision.current;
    setBusy(true);
    try {
      const result = pattern === "PARALLEL"
        ? await previewSurvey({polygon, spacing_m: spacing, angle_deg: bearing,
            altitude_m: altitude, speed_mps: speed})
        : await previewCircularSurvey({polygon, spacing_m: spacing,
            altitude_m: altitude, speed_mps: speed});
      if (revision !== previewRevision.current) return;
      setSurvey(result);
      setSelectedWaypoint(null);
      setEditedRoute(null);
      setManual([]);
      setOpenedMission(null);
      setDrawMode("NONE");
      notify("Generated " + result.lane_count + (pattern === "PARALLEL" ? " survey lanes." : " concentric loops.") + " Review route transitions before saving.");
      setFitSignal(x => x + 1);
    } catch (error) {
      if (revision === previewRevision.current) fail(error);
    } finally {
      setBusy(false);
    }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const route = editedRoute ?? survey?.waypoints ?? manual;
    if (!selected) return fail(new Error("Select a registered aircraft"));
    if (route.length < 2) return fail(new Error("Add two waypoints or preview a survey polygon"));
    setBusy(true);
    try {
      const draft = await saveMission({ vehicle_id: selected, title: missionTitle.trim(), waypoints: route });
      setOpenedMission(draft);
      setSelectedWaypoint(null);
      setSurvey(null); setEditedRoute(null); setPolygon([]); setManual([]); setMissionTitle("");
      setDrawMode("NONE");
      await refresh();
      notify("Saved draft " + draft.revision_sha256.slice(0, 12) + ". No flight-controller upload occurred.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  function openConnection(role?: ConnectionRole) {
    if (account?.role === "viewer") return;
    const requested = role ?? "PRIMARY";
    setConnectionRole(requested);
    setConnectionError("");
    setConnectOpen(true);
  }

  async function connectBrowserRadio(baud: number, systemId: number,
                                      useGranted = false) {
    if (!selected) {
      setConnectionError("Select an aircraft before connecting a browser radio.");
      return;
    }
    if (browserSerialRef.current) {
      setConnectionError("Browser radio already connected. Remove it before replacing the port.");
      return;
    }
    const receiver = new BrowserSerialReceiver();
    browserSerialRef.current = receiver;
    setBusy(true);
    setConnectionError("");
    try {
      // Browser requestPort is invoked directly from the user gesture here.
      await receiver.connect(selected, systemId, baud, sample => {
        setBrowserSerialSample(sample);
      }, error => setConnectionError(error), useGranted);
      setBrowserSerialAircraft(selected);
      setBrowserAutoSelect(true);
      setConnectOpen(false);
      notify("Windows USB radio opened in Chrome. Waiting for CRC-valid FC heartbeat and attitude before using it as standby.");
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Browser USB connection failed.");
      await receiver.stop();
      if (browserSerialRef.current === receiver) browserSerialRef.current = null;
    } finally {
      setBusy(false);
    }
  }

  async function removeBrowserRadio() {
    const radio = browserSerialRef.current;
    browserSerialRef.current = null;
    setBrowserSerialSelected(false);
    setBrowserAutoSelect(false);
    setBrowserSerialAircraft("");
    setBrowserSerialSample(null);
    await radio?.stop();
    setObservedTrack([]);
    notify("Local browser USB backup disconnected.");
  }

  async function startLink(settings: ConnectionRequest) {
    if (!selected) {
      setConnectionError("Register and select an aircraft before connecting.");
      return;
    }
    setBusy(true);
    setConnectionError("");
    try {
      const { role, method, origin, username, password, viewerToken,
        serialPort, baud, port, systemId } = settings;
      const isBackup = role === "BACKUP";
      let result: Telemetry;
      if (method === "BROKER") result = await (isBackup ? connectBackupBroker : connectBroker)(
        {vehicle_id:selected,origin,viewer_token:viewerToken,fc_system_id:systemId});
      else if (method === "LAN") result = await (isBackup ? connectBackupLAN : connectLAN)(
        {vehicle_id:selected,origin,viewer_token:viewerToken,fc_system_id:systemId});
      else if (method === "CLOUD") result = await (isBackup ? connectBackupCloud : connectCloud)(
        {vehicle_id:selected,origin,username,password,fc_system_id:systemId});
      else if (method === "SERIAL") result = await (isBackup ? connectBackupSerial : connectSerial)(
        {vehicle_id:selected,port:serialPort,baud,fc_system_id:systemId});
      else if (method === "TCP") result = await (isBackup ? connectBackupTCP : connectTCP)(
        {vehicle_id:selected,port,fc_system_id:systemId});
      else result = await (isBackup ? connectBackupUDP : connectUDP)(
        {vehicle_id:selected,port,fc_system_id:systemId});
      if (method === "CLOUD" || method === "BROKER" || method === "LAN") {
        // Only connection origins and relay username may be remembered,
        // never password, session cookie or scoped viewer token.
        try {
          window.localStorage.setItem("vihanga.receiver.origin." + method.toLowerCase() + ".v1", origin);
          if (method === "CLOUD")
            window.localStorage.setItem("vihanga.receiver.user.cloud.v1", username);
        } catch { /* Browser storage unavailable; connection still works. */ }
      }
      setReadings(previous => ({ ...previous, [selected]: result }));
      setConnectOpen(false);
      notify((isBackup ? "Backup" : "Primary") +
        " receiver initialized. Verify actual FC telemetry before selecting the source.");
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : "Connection could not be configured.");
    } finally {
      setBusy(false);
    }
  }
  async function chooseSource(role: "PRIMARY" | "BACKUP") {
    if (account?.role === "viewer") return;
    if (!selected) return;
    if (browserSerialAircraft === selected && browserSerialSample) {
      if (role === "BACKUP" && browserSerialSample.status !== "LIVE") {
        fail(new Error("Browser USB backup needs fresh FC heartbeat and attitude."));
        return;
      }
      setBrowserSerialSelected(role === "BACKUP");
      setObservedTrack([]);
      notify(role === "BACKUP" ? "Local browser USB backup selected." : "Cloud primary selected.");
      return;
    }
    setBusy(true);
    try {
      const result = await activateTelemetrySource(selected, role);
      setReadings(old => ({...old,[selected]:result}));
      setObservedTrack([]); // Never display an earlier source's track as the new source.
      notify(role === "BACKUP" ? "Backup receiver selected for monitoring." : "Primary receiver selected for monitoring.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function stopBackupLink() {
    if (!selected) return;
    if (browserSerialAircraft === selected) { await removeBrowserRadio(); return; }
    setBusy(true);
    try {
      const result = await disconnectBackup(selected);
      setReadings(old => ({ ...old, [selected]: result }));
      setObservedTrack([]);
      notify("Standby receiver removed. Primary remains a separate connection.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function stopLink() {
    if (!selected) return;
    if (browserSerialAircraft === selected) await removeBrowserRadio();
    setBusy(true);
    try {
      const result = await disconnectLink(selected);
      setReadings(old => ({ ...old, [selected]: result }));
      setObservedTrack([]);
      notify("Primary and standby telemetry receivers disconnected.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function requestBenchRead(query: BenchReadKind, parameter?: string) {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const receipt = await sendBenchRead(selected, query, parameter);
      notify(receipt.query + ": serial request written. Await the actual FC response.");
      setParameterReadback(await getParameterReadback(selected));
    } catch (error) { fail(error); }
    finally { setBusy(false); }
  }
  async function refreshParameters() {
    if (!selected) return;
    try { setParameterReadback(await getParameterReadback(selected)); }
    catch (error) { fail(error); }
  }
  function setVideo(event: FormEvent) {
    event.preventDefault();
    try {
      if (!selected) throw new Error("Select an aircraft before configuring video");
      if (!privateCameraUrl(cameraInput))
        throw new Error("Use a private HTTPS *.ts.net camera URL without credentials or query tokens");
      const page = new URL(cameraInput).href;
      const pages = { ...cameraPages, [selected]: page };
      setCameraPages(pages);
      try { window.localStorage.setItem("vihanga.camera.pages.v1", JSON.stringify(pages)); }
      catch { /* Browser storage disabled; current session still works. */ }
      notify("Camera configured for " + selected + ".");
    } catch (e) { fail(e); }
  }

  if (!boot.initialized) return null;

  return (
    <div className="workspace">
      <aside className="rail">
        <div className="identity"><span className="vihanga-logo"><img src="/vihanga-mark.svg" alt=""/></span><b>VIHANGA</b></div>
        <nav aria-label="Workspaces">
          {primarySections.map(item => <button key={item.label} type="button"
            aria-label={item.label} title={sectionTitles[item.label]}
            className={"rail-item " + (section === item.label ? "selected" : "")}
            onClick={() => navigate(item.label)} aria-current={section === item.label ? "page" : undefined}>
            <span className="rail-icon" aria-hidden="true"><UiIcon name={item.icon} size={28}/></span>
          </button>)}
          <select className="workspace-tools" aria-label="Station tools"
            value={["FLEET", "LINK", "BENCH", "HISTORY"].includes(section) ? section : ""}
            onChange={event => navigate(event.target.value as Section)}>
            <option value="" disabled>Tools</option>
            <option value="FLEET">Aircraft directory</option>
            <option value="LINK">Link health</option>
            <option value="BENCH">Bench</option>
            <option value="HISTORY">Saved routes</option>
          </select>
        </nav>
      </aside>
      {fleetOpen && <aside className="fleetbar">
        <div className="fleetbar-head"><span>AIRCRAFT</span><strong>{vehicles.length}</strong></div>
        <div className="fleet-filters">
          <input aria-label="Search aircraft" value={aircraftSearch} placeholder="Search ID or aircraft"
            onChange={e => setAircraftSearch(e.target.value)}/>
          <div className="filter-buttons">
            {(["ALL","LIVE","OFFLINE"] as const).map(filter => <button type="button" key={filter}
              className={aircraftFilter === filter ? "selected" : ""}
              onClick={() => setAircraftFilter(filter)}>{filter === "ALL" ? "All" : filter === "LIVE" ? "Online" : "Offline"}</button>)}
          </div>
        </div>
        <div className="aircraft-items">
          {vehicles.length === 0 && <p className="sidebar-empty">No aircraft registered. Use FLEET to add one.</p>}
          {fleetMatches.map(v => {
            const status = aircraftStatus(v.vehicle_id);
            return <button key={v.vehicle_id} type="button"
              onClick={() => setSelected(v.vehicle_id)}
              className={"aircraft-item " + (selected === v.vehicle_id ? "current" : "")}>
              <div className="aircraft-icon">✈</div><div className="aircraft-info">
                <strong>{v.label}</strong><span>{v.vehicle_id}</span>
                <small className={status === "LIVE" ? "working" : ""}>{linkLabel(status)}</small>
              </div><span className={"aircraft-dot " + (status === "LIVE" ? "online" : "")}/>
            </button>;
          })}
        </div>
        <button className="add-aircraft" onClick={() => navigate("FLEET")}>+ Register aircraft</button>
        <div className="fleetbar-foot">
          <div>ACTIVE STREAMS <b>{liveCount}</b></div>
        </div>
      </aside>}
      <div className="main-area">
        <header className="toolbar">
          <div className="toolbar-leading" key={section}>
            <strong>{sectionTitles[section]}</strong>
            {active && <span className="toolbar-subtitle">{active.label}</span>}
          </div>
          <div className="toolbar-right">
            {account && <button type="button" className="toolbar-button" title={account.name + " · " + account.role}
              onClick={account.signOut}>Sign out</button>}
            {!boot.ready && <button type="button" className="toolbar-button" disabled={!boot.finished}
              onClick={boot.retry}>{boot.finished ? "Retry startup checks" : "Checking station"}</button>}
            <button type="button" className="toolbar-button fleet-toggle"
              aria-label={fleetOpen ? "Hide aircraft list" : "Show aircraft list"}
              aria-pressed={fleetOpen} onClick={() => setFleetOpen(v => !v)}>
              <UiIcon name="fleet" size={15}/> {fleetOpen ? "Hide aircraft" : "Aircraft"}
            </button>
            <span className={"link-chip " + (displaySample?.status === "LIVE" ? "ok" : "")}>
              <span className="chip-dot"/>{linkLabel(displaySample?.status)}
            </span>
            <span className="vehicle-chip">{active?.vehicle_id || "NO AIRCRAFT"}</span>
            <button type="button" className="toolbar-button diagnostics-toggle"
              onClick={() => setDiagnosticsOpen(open => !open)}
              aria-expanded={diagnosticsOpen}
              aria-label={diagnosticsOpen ? "Hide link diagnostics" : "Show link diagnostics"}
              disabled={!selected} title="Live link, backup and sensor diagnostics">
              <UiIcon name="activity" size={16}/> Diagnostics
            </button>
            <button className="toolbar-button accent" onClick={() => openConnection()}
              disabled={!selected || account?.role === "viewer"} title="Configure primary or backup telemetry receiver">
              <UiIcon name="radio" size={15}/> Connections
            </button>
          </div>
        </header>
        {section === "BENCH" && <PanelLoader name="bench">
          <Bench key={selected} aircraftId={selected} telemetry={primarySample}
            browserTelemetry={localBrowserSample} activeBrowser={browserSerialSelected} readOnly={account?.role === "viewer"}/>
        </PanelLoader>}
        <div hidden={section === "BENCH"}
          className={"map-stage " + ((section === "FLIGHT" || section === "PLAN") ? "has-operations" : "")}>
          <PanelLoader name="map" floating>
            <GeoMap polygon={section === "PLAN" ? polygon : EMPTY_POLYGON} route={section === "PLAN" || section === "HISTORY" || section === "FLIGHT" ? waypoints : EMPTY_ROUTE}
              track={mapVisible ? observedTrack : EMPTY_TRACK} position={mapVisible ? location : null} drawing={section === "PLAN" && drawMode !== "NONE"}
              editingBoundary={section === "PLAN" && drawMode === "POLYGON"}
              basemap={basemap} centerSignal={centerSignal} fitSignal={fitSignal}
              review={section === "FLIGHT" ? reviewPoint : null}
              follow={section === "FLIGHT" && !reviewPoint && followAircraft} onFollowInterrupted={stopFollowing}
              selectedWaypoint={selectedWaypoint} onWaypointSelect={setSelectedWaypoint}
              fitLeftPadding={panelOpen && (section === "PLAN" || section === "HISTORY") ? 414 : 76}
              onMapClick={clicked} onVertexMove={moveVertex}/>
          </PanelLoader>
          <div className="map-tools" role="group" aria-label="Map controls">
            <select aria-label="Map layer" value={basemap}
              onChange={event => setBasemap(event.target.value as Basemap)}>
              <option value="satellite">Satellite</option>
              <option value="streets">Streets</option>
              <option value="grid">Offline grid</option>
            </select>
            <button disabled={!location} title={!location ? "No fresh GPS fix" : "Center selected aircraft"}
              onClick={() => setCenterSignal(x => x + 1)}>Aircraft</button>
            {section === "FLIGHT" && <button type="button" className={followAircraft ? "chosen" : ""}
              aria-pressed={followAircraft} aria-label="Follow aircraft" disabled={!followAircraft && !location}
              title={!location ? "No fresh GPS fix" : "Keep the map centered on the aircraft"}
              onClick={() => setFollowedAircraftId(followAircraft ? "" : selected)}>Follow</button>}
            {(waypoints.length > 0 || polygon.length > 0) && <button type="button"
              title="Fit survey or route to map"
              onClick={() => { stopFollowing(); setFitSignal(x => x + 1); }}>Fit route</button>}
          </div>
          {section === "PLAN" && <div className="operation-ribbon" role="toolbar" aria-label="Planning tools">
            <button className={section === "PLAN" && drawMode === "POLYGON" ? "active" : ""}
              aria-pressed={section === "PLAN" && drawMode === "POLYGON"}
              onClick={() => startDrawing("POLYGON")} title="Draw survey boundary"><UiIcon name="plan" size={15}/> <span>Survey</span></button>
            <button className={section === "PLAN" && drawMode === "WAYPOINT" ? "active" : ""}
              aria-pressed={section === "PLAN" && drawMode === "WAYPOINT"}
              onClick={() => startDrawing("WAYPOINT")} title="Add manual waypoints"><UiIcon name="map" size={15}/> <span>Waypoints</span></button>
            {drawMode !== "NONE" && <button type="button" onClick={() => setDrawMode("NONE")}>Finish</button>}
            <button onClick={() => navigate("HISTORY")} title="View stored mission drafts"><UiIcon name="history" size={15}/> <span>Routes</span></button>
          </div>}
          {!panelOpen && section !== "FLIGHT" && <div className="panel-launcher">
            <button type="button" onClick={() => setPanelOpen(true)}
              aria-expanded={false} aria-controls="operator-panel"
              aria-label="Show operator panel">
              <UiIcon name="map" size={16}/> {section === "PLAN" ? "Edit plan" : "Open panel"}
            </button>
            {section === "PLAN" && waypoints.length > 0 &&
              <span className="route-count">{waypoints.length} waypoint{waypoints.length === 1 ? "" : "s"}</span>}
          </div>}
          {panelOpen && section === "CONTROL" && <PanelLoader name="controls" floating>
            <ControlPanel
              aircraftId={selected} catalog={operatorCatalog} telemetry={sample}
              readback={parameterReadback} busy={busy}
              onClose={() => setPanelOpen(false)}
              onBenchQuery={(query, parameter) => { void requestBenchRead(query, parameter); }}
              onRefreshReadback={() => { void refreshParameters(); }}
            />
          </PanelLoader>}
          {panelOpen && section === "PLAN" && <section id="operator-panel" className="float-panel plan-panel">
            <div className="panel-title">
              <h2>Survey planner</h2>
              <span>{openedMission ? "SAVED DRAFT" : survey ? "PREVIEW READY" : "DRAFT"}</span>
            <button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <div className="plan-tabs" aria-label="Coverage pattern">
              <button type="button" className={pattern === "PARALLEL" ? "active" : ""}
                onClick={() => { setPattern("PARALLEL"); clearPreview(); }}>Parallel</button>
              <button type="button" className={pattern === "CIRCULAR" ? "active" : ""}
                onClick={() => { setPattern("CIRCULAR"); clearPreview(); }}>Circular</button>
            </div>
            <div className="planner-quick-actions" role="group" aria-label="Planner editing tools">
              <button type="button" onClick={undoPlannerPoint}
                disabled={!!openedMission || !(drawMode === "POLYGON" ? polygon.length :
                  survey?.pattern !== "CIRCULAR" && waypoints.length)}
                title="Remove the last route waypoint or polygon vertex">Undo last</button>
              <button type="button" onClick={clearWaypoints} disabled={!waypoints.length}
                title="Clear displayed waypoints without deleting saved missions">Clear waypoints</button>
              <button type="button" onClick={clearBoundary} disabled={!polygon.length}
                title="Remove the survey boundary">Clear boundary</button>
              <button type="button" className="planner-reset" onClick={resetPlanner}
                disabled={!polygon.length && !waypoints.length && !missionTitle}
                title="Reset planner settings and geometry; saved missions remain intact">Reset</button>
            </div>
            {drawMode !== "NONE" && <div className="drawing-note">
              Map editing active · Click to add {drawMode === "POLYGON" ? "survey vertices" : "route waypoints"}.
            </div>}
            <div className="survey-controls">
              <label>Line / ring spacing
                <div className="value-row"><input type="range" min="5" max="100" step="1" value={spacing}
                  onChange={e => {setSpacing(Number(e.target.value)); clearPreview();}}/>
                  <input className="value-box" type="number" min="5" max="200" value={spacing}
                    onChange={e => {setSpacing(Number(e.target.value)); clearPreview();}}/><span>m</span></div>
              </label>
              {pattern === "PARALLEL" && <label>Grid angle
                <div className="value-row"><input type="range" min="0" max="179" value={bearing}
                  onChange={e => {setBearing(Number(e.target.value)); clearPreview();}}/>
                  <input className="value-box" type="number" min="0" max="179" value={bearing}
                    onChange={e => {setBearing(Number(e.target.value)); clearPreview();}}/><span>°</span></div>
              </label>}
              <label>Flight altitude
                <div className="value-row"><input type="range" min="10" max="120" value={altitude}
                  onChange={e => {setAltitude(Number(e.target.value)); clearPreview();}}/>
                  <input className="value-box" type="number" min="10" max="120" value={altitude}
                    onChange={e => {setAltitude(Number(e.target.value)); clearPreview();}}/><span>m</span></div>
              </label>
              <label>Planned groundspeed
                <div className="value-row"><input type="range" min="0.5" max="20" step="0.5" value={speed}
                  onChange={e => {setSpeed(Number(e.target.value)); clearPreview();}}/>
                  <input className="value-box" type="number" min="0.5" max="25" step="0.5" value={speed}
                    onChange={e => {setSpeed(Number(e.target.value)); clearPreview();}}/><span>m/s</span></div>
              </label>
            </div>
            <div className="plan-buttons">
              <button type="button" disabled={!polygon.length && !waypoints.length}
                onClick={() => setFitSignal(v => v+1)}>Fit geometry on map</button>
            </div>
            <button type="button" className="major" disabled={busy || polygon.length < 3}
              onClick={() => void preview()}>{busy ? "Working…" : "Generate coverage route"}</button>
            {survey?.coverage_note && <div className="drawing-note">{survey.coverage_note}
              {survey.pattern === "CIRCULAR" && " Edit the boundary or spacing to reposition the loops."}
            </div>}
            {waypoints.length > 0 && <div className="route-editor">
              <div className="route-editor-head">
                <strong>Waypoints <span className="route-total">{waypoints.length}</span></strong>
                <span>{openedMission ? "SAVED ROUTE" : "DRAFT ROUTE"}</span>
              </div>
              <div className="route-scroll" aria-label="Mission waypoint list">
                {waypoints.map((p,i) => <div
                  className={"route-row" + (selectedWaypoint === i ? " picked" : "")} key={i}>
                  <button type="button" className="waypoint-index"
                    title={"Highlight waypoint " + (i + 1) + " on the map"}
                    aria-label={"Select waypoint " + (i + 1)}
                    aria-pressed={selectedWaypoint === i}
                    onClick={() => setSelectedWaypoint(i)}>{i + 1}</button>
                  <label>LAT<input key={p.latitude} disabled={!!openedMission || survey?.pattern === "CIRCULAR"} type="number" step="any"
                    defaultValue={p.latitude} onFocus={() => setSelectedWaypoint(i)}
                    onBlur={e => reviseWaypoint(i,"latitude",e.target.value)}/></label>
                  <label>LON<input key={p.longitude} disabled={!!openedMission || survey?.pattern === "CIRCULAR"} type="number" step="any"
                    defaultValue={p.longitude} onFocus={() => setSelectedWaypoint(i)}
                    onBlur={e => reviseWaypoint(i,"longitude",e.target.value)}/></label>
                  <label>ALT<input key={p.altitude_m} disabled={!!openedMission} type="number" min="0" max="120"
                    defaultValue={p.altitude_m} onFocus={() => setSelectedWaypoint(i)}
                    onBlur={e => reviseWaypoint(i,"altitude_m",e.target.value)}/></label>
                </div>)}
              </div>
            </div>}
            <div className="plan-stats">
              <div><span>Boundary vertices</span><strong>{polygon.length}</strong></div>
              <div><span>{pattern === "CIRCULAR" ? "Concentric rings" : "Flight lines"}</span><strong>{survey?.lane_count ?? "—"}</strong></div>
              <div><span>Route waypoints</span><strong>{waypoints.length}</strong></div>
              <div><span>Route distance</span><strong>{survey ? (survey.route_distance_m/1000).toFixed(2) + " km" : "—"}</strong></div>
              <div><span>Travel time estimate</span><strong>{survey ? (survey.estimated_duration_s/60).toFixed(1) + " min" : "—"}</strong></div>
            </div>
            <div className="export-actions">
              <button type="button" onClick={exportDraftGeoJSON} disabled={waypoints.length < 2}>Export GeoJSON</button>
            </div>
            <form className="save-form" onSubmit={e => void saveDraft(e)}>
              <label>Mission name<input required minLength={3} maxLength={100}
                placeholder="Boundary survey · Site 01" value={missionTitle}
                onChange={e => setMissionTitle(e.target.value)}/></label>
              <button type="submit" className="major" disabled={busy || waypoints.length < 2 || !selected || !!openedMission}>Save mission draft</button>
            </form>
            <div className="plan-handoff">
              <button type="button" className="flight-handoff-button"
                disabled={waypoints.length < 2 || !selected} onClick={() => {
                  setDrawMode("NONE");
                  navigate("FLIGHT");
                  setFitSignal(x => x + 1);
                }}>Review for Flight</button>
              <p>Carry this route into the Flight workspace. This does not arm,
                upload a mission or start the motors.</p>
            </div>
            <p className="panel-footnote">Check terrain, obstacles and airspace before flight. Mission upload is not yet integrated.</p>
          </section>}
          {panelOpen && section === "FLEET" && <section id="operator-panel" className="float-panel utility-panel">
            <div className="panel-title"><h2>Aircraft registry</h2><span>{vehicles.length} registered</span><button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <form onSubmit={e => void addAircraft(e)} className="form-stack">
              <label>Aircraft ID<input required placeholder="AH-HW-001" minLength={3} maxLength={32}
                value={vehicleForm.vehicle_id} onChange={e => setVehicleForm({ ...vehicleForm, vehicle_id: e.target.value.toUpperCase() })}/></label>
              <label>Display name<input required placeholder="Survey quadcopter" minLength={3} maxLength={80}
                value={vehicleForm.label} onChange={e => setVehicleForm({ ...vehicleForm, label: e.target.value })}/></label>
              <label>Autopilot<select value={vehicleForm.autopilot}
                onChange={e => setVehicleForm({ ...vehicleForm, autopilot: e.target.value as VehicleCreate["autopilot"] })}>
                <option value="ARDUPILOT">ArduPilot</option><option value="PX4">PX4</option>
                <option value="OTHER">Other</option></select></label>
              <label>FC interface<select value={vehicleForm.interface}
                onChange={e => setVehicleForm({ ...vehicleForm, interface: e.target.value as VehicleCreate["interface"] })}>
                <option value="UART">UART</option><option value="USB">USB</option>
                <option value="ETHERNET">Ethernet</option><option value="OTHER">Other</option></select></label>
              <button className="major" type="submit" disabled={busy}>Register aircraft</button>
            </form>

          </section>}
          {panelOpen && section === "LINK" && <section id="operator-panel" className="float-panel utility-panel">
            <div className="panel-title"><h2>Connection diagnostics</h2><span>Receive-only</span><button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <div className="status-rows">
              <div><span>Selected aircraft</span><strong>{selected || "—"}</strong></div>
              <div><span>Transport</span><strong>{sample?.transport || "NONE"}</strong></div>
              <div><span>Status</span><strong>{linkLabel(sample?.status)}</strong></div>
              <div><span>Frames received</span><strong>{sample?.frames_total ?? 0}</strong></div>
              <div><span>Frame rate (5 s)</span><strong>{sample ? sample.frame_rate_5s_hz.toFixed(2) + " Hz" : "—"}</strong></div>
              <div><span>Observed track points</span><strong>{observedTrack.length}</strong></div>
              <div><span>Local telemetry viewer</span><strong>{liveTransportConnected ? "WEBSOCKET ACTIVE" : "POLLING"}</strong></div>
              <div><span>Rejected frames</span><strong>{sample?.rejected_frames ?? 0}</strong></div>
              <div><span>Last packet age</span><strong>{sample?.age_ms == null ? "—" : sample.age_ms + " ms"}</strong></div>
              <div><span>Receiver error</span><strong>{sample?.error_code || "—"}</strong></div>
            </div>
            <div className="plan-buttons">
              <button className="major" disabled={!selected} onClick={() => openConnection()}>Connection settings</button>
              <button disabled={!sample || sample.status === "OFFLINE" || busy} onClick={() => void stopLink()}>Disconnect</button>
            </div>
            <p className="panel-footnote">Cloud uses authenticated private WSS; UDP accepts SITL frames only on localhost. Neither transport forwards commands to an FC.</p>
          </section>}
          {panelOpen && section === "HISTORY" && <section id="operator-panel" className="float-panel utility-panel history-panel">
            <div className="panel-title"><h2>Saved routes</h2><span>{displayedMissionList.length} drafts</span><button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <div className="history-list">
              {displayedMissionList.length === 0 && <p className="panel-footnote">No saved drafts for this aircraft.</p>}
              {displayedMissionList.map(m => <button key={m.mission_id} onClick={() => {
                setOpenedMission(m);
                clearPreview(); setManual([]); setPolygon([]);
              }} className={openedMission?.mission_id === m.mission_id ? "picked" : ""}>
                <strong>{m.title}</strong>
                <span>{m.waypoints.length} points · {(m.distance_m / 1000).toFixed(2)} km</span>
                <small>{m.revision_sha256.slice(0, 16)} · DRAFT</small>
              </button>)}
            </div>
          </section>}
          {panelOpen && section === "VIDEO" && <section id="operator-panel" className="float-panel utility-panel video-panel" data-expanded={cameraExpanded && Boolean(cameraUrl)}>
            <div className="panel-title"><h2><UiIcon name="video" size={20}/> Camera</h2>
              {cameraUrl && <button type="button" aria-pressed={cameraExpanded}
                onClick={() => setCameraExpanded(open => !open)}>{cameraExpanded ? "Restore size" : "Expand camera"}</button>}<button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <form onSubmit={setVideo} className="form-stack">
              <label>Private stream page (HTTPS)<input value={cameraInput} type="url" required
                placeholder="https://aircraft.ts.net/cam"
                onChange={e => setCameraInput(e.target.value)}/></label>
              <button className="major" type="submit">Open camera</button>
            </form>
            {cameraUrl && <div className="video-container">
              <iframe title="Authenticated aircraft camera" src={cameraUrl}
                referrerPolicy="no-referrer" allow="autoplay; fullscreen" allowFullScreen/>
              <a href={cameraUrl} target="_blank" rel="noopener noreferrer">Open full camera page ↗</a>
            </div>}
          </section>}
          {section === "LINK" && <div className={"ops-signal-strip" + (diagnosticsOpen ? " drawer-open" : "")}
            aria-label="Aircraft link summary">
            <div className={"ops-signal-item " + (sample?.heartbeat_fresh ? "healthy" : "fault")}
              title="Flight-controller heartbeat only. Does not measure handheld RC signal or radio failover.">
              <UiIcon name="activity" size={15}/>
              <span>FC HEARTBEAT</span><strong>{sample?.heartbeat_fresh ? "LIVE" : "STALE"}</strong>
            </div>
            <div className={"ops-signal-item " +
              (sample?.gps_fix_type != null && sample.gps_fix_type >= 3 ? "healthy" : "caution")}>
              <UiIcon name="map" size={15}/>
              <span>GPS</span><strong>{sample?.gps_fix_type == null ? "—" : "FIX " + sample.gps_fix_type}</strong>
            </div>
            <div className={"ops-signal-item " +
              (sample?.rc_input_status === "FAILSAFE" || sample?.rc_input_status === "FC_FAULT"
                ? "fault" : "caution")}
              title="RC RF presence is not verified by a Pixhawk heartbeat or static channel PWM. Click Link & sensors for FC evidence.">
              <UiIcon name="radio" size={15}/>
              <span>RC RADIO</span><strong>{sample?.rc_input_status === "FAILSAFE" ? "FAILSAFE" :
                sample?.rc_input_status === "FC_FAULT" ? "FAULT" :
                sample?.rc_input_status === "CHANNELS_REPORTED" ? "DATA ONLY" : "UNVERIFIED"}</strong>
            </div>
            <button type="button" className="ops-summary-button"
              aria-label={diagnosticsOpen ? "Close link and sensors panel" : "Open link and sensors panel"}
              aria-expanded={diagnosticsOpen}
              onClick={() => setDiagnosticsOpen(open => !open)}>
              {diagnosticsOpen ? "Close panel" : "Link & sensors"}
            </button>
          </div>}
          <NetworkWatch aircraftId={selected} telemetry={sample} viewerConnected={liveTransportConnected}/>
          {diagnosticsOpen && <PanelLoader name="diagnostics" floating>
            <OperationsPanel
              aircraftId={selected} telemetry={sample} busy={busy}
              onClose={() => setDiagnosticsOpen(false)}
              onConfigureBackup={() => openConnection("BACKUP")}
              onSelect={role => { void chooseSource(role); }}
              onRemoveBackup={() => { void stopBackupLink(); }}
            />
          </PanelLoader>}
          {(location || observedTrack.length > 0 || waypoints.length > 0 || basemap === "grid") &&
            <div className="map-coordinates">
              {location && <span>{location.latitude.toFixed(5)}°, {location.longitude.toFixed(5)}°</span>}
              {observedTrack.length > 0 && <span> · Blue: observed track</span>}
              {waypoints.length > 0 && <span> · Amber: route draft</span>}
              {basemap === "grid" && <span> · Offline map</span>}
            </div>}
          {alert && <div className="toast error" role="alert">{alert}<button onClick={() => setAlert("")}>×</button></div>}
          {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
        </div>
        <div hidden={section !== "FLIGHT"} className="station-instrument-area">
          <FlightInstruments operator={account?.name} onReview={setReviewPoint} telemetry={displaySample} aircraftId={selected}/>
        </div>
        <footer className="station-statusbar" aria-label="Station status">
          <span>MODE <strong>{current?.heartbeat_fresh ? current.mode ?? "—" : "—"}</strong></span>
          <span>FC <strong className={current?.armed === true ? "station-armed" : ""}>
            {!current?.heartbeat_fresh || current.armed == null ? "—" : current.armed ? "ARMED" : "DISARMED"}
          </strong></span>
          <span>SOURCE <strong>{current?.transport === "BROWSER_SERIAL_READ_ONLY" ? "PC USB" :
            current?.transport ? current.active_source ?? "PRIMARY" : "—"}</strong></span>
          <span>PACKET <strong className={displaySample?.status === "STALE" ? "station-stale" : undefined}>
            {displaySample?.status === "STALE" ? "STALE" : current?.age_ms == null ? "—" : Math.round(current.age_ms) + " ms"}
          </strong></span>
          <span className="station-authority">TELEMETRY ONLY</span>
        </footer>
      </div>
      {connectOpen && <PanelLoader name="connections">
        <ConnectionSettings
          aircraftName={active?.label || "Aircraft"}
          aircraftId={selected}
          telemetry={sample}
          initialRole={connectionRole}
          busy={busy}
          error={connectionError}
          onConnect={startLink}
          onConnectBrowserSerial={connectBrowserRadio}
          onActivate={chooseSource}
          onRemoveBackup={stopBackupLink}
          onDisconnect={stopLink}
          onClearError={() => setConnectionError("")}
          onClose={() => {
          if (!busy) { setConnectOpen(false); setConnectionError(""); }
          }}
        />
      </PanelLoader>}
    </div>
  );
}
