import { useEffect, useMemo, useState, type FormEvent } from "react";
import GeoMap, { type MapPoint } from "./GeoMap";
import FlightInstruments from "./FlightInstruments";
import OperationsPanel from "./OperationsPanel";
import ControlPanel from "./ControlPanel";
import NetworkWatch from "./NetworkWatch";
import ConnectionSettings, { type ConnectionRequest, type ConnectionRole } from "./ConnectionSettings";
import UiIcon, { type IconName } from "./UiIcon";
import {
  connectBroker, connectCloud, connectLAN, connectUDP, connectTCP, connectSerial, disconnectLink,
  connectBackupBroker, connectBackupCloud, connectBackupLAN, connectBackupSerial, connectBackupUDP, connectBackupTCP,
  activateTelemetrySource, disconnectBackup, getHealth, getMissions,
  getOperatorCatalog, getParameterReadback, sendBenchRead,
  getFleetTelemetry, getObservedTrack, getVehicles, previewSurvey, previewCircularSurvey, registerVehicle, saveMission,
  type Health, type Mission, type SurveyPreview, type Telemetry,
  type Vehicle, type VehicleCreate, type Waypoint,
  type BenchReadKind, type OperatorCatalog, type ParameterReadback
} from "./api";

type Section = "FLIGHT" | "CONTROL" | "PLAN" | "FLEET" | "LINK" | "HISTORY" | "VIDEO";
type DrawMode = "NONE" | "POLYGON" | "WAYPOINT";
const EMPTY_POLYGON: MapPoint[] = [];
const EMPTY_ROUTE: Waypoint[] = [];
const sections: { label: Section; icon: IconName }[] = [
  { label: "FLIGHT", icon: "flight" }, { label: "CONTROL", icon: "shield" }, { label: "PLAN", icon: "plan" },
  { label: "FLEET", icon: "fleet" }, { label: "LINK", icon: "link" },
  { label: "HISTORY", icon: "history" }, { label: "VIDEO", icon: "video" }
];

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

export default function App() {
  const [section, setSection] = useState<Section>("FLIGHT");
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [selected, setSelected] = useState("");
  const [readings, setReadings] = useState<Record<string, Telemetry>>({});
  const [observedTrack, setObservedTrack] = useState<MapPoint[]>([]);
  const [liveTransportConnected, setLiveTransportConnected] = useState(false);
  const [alert, setAlert] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [fleetOpen, setFleetOpen] = useState(true);
  const [basemap, setBasemap] = useState<"satellite" | "streets">("satellite");
  const [centerSignal, setCenterSignal] = useState(0);

  const [vehicleForm, setVehicleForm] = useState<VehicleCreate>(initialVehicle);
  const [drawMode, setDrawMode] = useState<DrawMode>("NONE");
  const [polygon, setPolygon] = useState<MapPoint[]>([]);
  const [manual, setManual] = useState<Waypoint[]>([]);
  const [survey, setSurvey] = useState<SurveyPreview | null>(null);
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

  const [cameraInput, setCameraInput] = useState("");
  const [cameraPages, setCameraPages] = useState<Record<string, string>>(restoredCameras);
  useEffect(() => { setCameraInput(cameraPages[selected] ?? ""); }, [selected]);

  async function refresh() {
    try {
      const [v, m, h] = await Promise.all([getVehicles(), getMissions(), getHealth()]);
      setVehicles(v);
      setMissions(m);
      setHealth(h);
      setSelected(prev => v.some(x => x.vehicle_id === prev) ? prev : v[0]?.vehicle_id ?? "");
    } catch (e) {
      setHealth(null);
      setAlert(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (vehicles.length === 0) { setReadings({}); return; }
    let mounted = true;
    let inflight = false;
    async function poll() {
      if (inflight) return;
      inflight = true;
      try {
        const next = await getFleetTelemetry();
        if (mounted) setReadings(next);
      } catch {
        // A selected-aircraft WebSocket still updates independently.
      } finally { inflight = false; }
    }
    void poll();
    const handle = window.setInterval(() => void poll(), 1600);
    return () => { mounted = false; window.clearInterval(handle); };
  }, [vehicles.length]);


  // Low-latency local viewer; the backend streams only real FC-derived state.
  // A separate fleet poll remains as a bounded fallback for disconnected clients.
  useEffect(() => {
    if (!selected) { setLiveTransportConnected(false); return; }
    let stopped = false;
    let retry: number | undefined;
    let ws: WebSocket | null = null;
    function open() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const path = "/ws/v1/telemetry/" + encodeURIComponent(selected);
      ws = new WebSocket(protocol + "//" + window.location.host + path);
      ws.onopen = () => { if (!stopped) setLiveTransportConnected(true); };
      ws.onmessage = event => {
        if (stopped) return;
        try {
          const sample = JSON.parse(String(event.data)) as Telemetry;
          if (sample.vehicle_id === selected) {
            setReadings(previous => ({ ...previous, [selected]: sample }));
          }
        } catch { /* ignore malformed local frame; do not display it */ }
      };
      ws.onclose = () => {
        setLiveTransportConnected(false);
        if (!stopped) retry = window.setTimeout(open, 1600);
      };
      ws.onerror = () => ws?.close();
    }
    open();
    return () => {
      stopped = true;
      if (retry !== undefined) window.clearTimeout(retry);
      ws?.close();
      setLiveTransportConnected(false);
    };
  }, [selected]);

  useEffect(() => {
    setObservedTrack([]);
    if (!selected) return;
    let stopped = false;
    async function refreshTrack() {
      try {
        const result = await getObservedTrack(selected);
        if (!stopped) setObservedTrack(result.points);
      } catch {
        if (!stopped) setObservedTrack([]);
      }
    }
    void refreshTrack();
    const timer = window.setInterval(() => void refreshTrack(), 2800);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [selected]);

  const active = vehicles.find(v => v.vehicle_id === selected);
  const sample = readings[selected];
  useEffect(() => {
    if (!selected) {
      setOperatorCatalog(null);
      setParameterReadback(null);
      return;
    }
    let cancelled = false;
    getOperatorCatalog(selected).then(result => {
      if (!cancelled) setOperatorCatalog(result);
    }).catch(() => { if (!cancelled) setOperatorCatalog(null); });
    return () => { cancelled = true; };
  }, [selected, sample?.transport, sample?.status, sample?.active_source]);
  useEffect(() => {
    setParameterReadback(null);
    if (!selected) return;
    let cancelled = false;
    getParameterReadback(selected).then(result => {
      if (!cancelled) setParameterReadback(result);
    }).catch(() => { if (!cancelled) setParameterReadback(null); });
    return () => { cancelled = true; };
  }, [selected, sample?.transport, sample?.active_source]);
  const cameraUrl = cameraPages[selected] ?? "";
  const location = sample?.latitude != null && sample.longitude != null
    ? { latitude: sample.latitude, longitude: sample.longitude } : null;
  const waypoints = openedMission?.waypoints ?? editedRoute ?? survey?.waypoints ?? manual;
  const fleetMatches = vehicles.filter(v => {
    const q = aircraftSearch.trim().toLowerCase();
    const match = !q || v.label.toLowerCase().includes(q) || v.vehicle_id.toLowerCase().includes(q);
    const status = readings[v.vehicle_id]?.status;
    return match && (aircraftFilter === "ALL" || (aircraftFilter === "LIVE" ? status === "LIVE" : status !== "LIVE"));
  });
  const displayedMissionList = missions.filter(m => m.vehicle_id === selected);
  const liveCount = useMemo(
    () => Object.values(readings).filter(t => t.status === "LIVE").length, [readings]
  );

  function notify(text: string) { setNotice(text); setAlert(""); }
  function fail(error: unknown) {
    setNotice("");
    setAlert(error instanceof Error ? error.message : String(error));
  }
  function navigate(page: Section) {
    setSelectedWaypoint(null);
    setPanelOpen(true);
    setSection(page);
    setDrawMode("NONE");
    setAlert(""); setNotice("");
  }
  function clicked(point: MapPoint) {
    if (section !== "PLAN") return;
    setOpenedMission(null);
    setSurvey(null);
    setEditedRoute(null);
    if (drawMode === "POLYGON") {
      setSelectedWaypoint(null);
      setPolygon(old => [...old, point]);
    }
    if (drawMode === "WAYPOINT") {
      setSelectedWaypoint(manual.length);
      setManual(old => [...old, { ...point, altitude_m: altitude }]);
    }
  }


  function clearWaypoints() {
    // A saved route is immutable in the database. Clearing only changes the
    // on-screen draft and its visible map geometry, not saved mission records.
    setOpenedMission(null);
    setManual([]);
    setSurvey(null);
    setEditedRoute(null);
    setSelectedWaypoint(null);
    notify("Waypoint layer cleared.");
  }

  function clearBoundary() {
    setPolygon([]);
    if (survey) {
      setSurvey(null);
      setEditedRoute(null);
    }
    setSelectedWaypoint(null);
    notify("Survey boundary cleared.");
  }

  function resetPlanner() {
    setPolygon([]);
    setManual([]);
    setSurvey(null);
    setEditedRoute(null);
    setOpenedMission(null);
    setSelectedWaypoint(null);
    setDrawMode("NONE");
    setPattern("PARALLEL");
    setSpacing(20);
    setBearing(0);
    setAltitude(35);
    setSpeed(5);
    setMissionTitle("");
    notify("Planner reset. Saved mission records were not deleted.");
  }

  function undoPlannerPoint() {
    if (openedMission) return;
    if (drawMode === "POLYGON") {
      setPolygon(previous => previous.slice(0, -1));
      setSurvey(null);
      setEditedRoute(null);
    } else {
      const previous = editedRoute ?? survey?.waypoints ?? manual;
      if (survey || editedRoute) setEditedRoute(previous.slice(0, -1));
      else setManual(points => points.slice(0, -1));
    }
    setSelectedWaypoint(null);
  }

  function reviseWaypoint(index: number, field: "latitude" | "longitude" | "altitude_m", raw: string) {
    if (openedMission) return; // saved mission revisions are immutable
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    if ((field === "latitude" && Math.abs(n) > 90) ||
        (field === "longitude" && Math.abs(n) > 180) ||
        (field === "altitude_m" && (n < 0 || n > 120))) return;
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
    if (section !== "PLAN" || openedMission) return;
    setPolygon(p => p.map((v,i) => i === index ? point : v));
    setSurvey(null);
    setEditedRoute(null);
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
    setBusy(true);
    try {
      const result = pattern === "PARALLEL"
        ? await previewSurvey({polygon, spacing_m: spacing, angle_deg: bearing,
            altitude_m: altitude, speed_mps: speed})
        : await previewCircularSurvey({polygon, spacing_m: spacing,
            altitude_m: altitude, speed_mps: speed});
      setSurvey(result);
      setSelectedWaypoint(null);
      setEditedRoute(null);
      setManual([]);
      setOpenedMission(null);
      setDrawMode("NONE");
      notify("Generated " + result.lane_count + (pattern === "PARALLEL" ? " survey lanes." : " concentric loops.") + " Review route transitions before saving.");
      setFitSignal(x => x + 1);
    } catch (e) { fail(e); } finally { setBusy(false); }
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
    const requested = role ?? "PRIMARY";
    setConnectionRole(requested);
    setConnectionError("");
    setConnectOpen(true);
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
    if (!selected) return;
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

  return (
    <div className="workspace">
      <aside className="rail">
        <div className="identity"><span className="vihanga-logo"><img src="/vihanga-mark.svg" alt=""/></span><b>VIHANGA</b></div>
        <nav aria-label="Workspaces">
          {sections.map(item => <button key={item.label} type="button"
            className={"rail-item " + (section === item.label ? "selected" : "")}
            onClick={() => navigate(item.label)} aria-current={section === item.label ? "page" : undefined}>
            <span className="rail-icon"><UiIcon name={item.icon} size={21}/></span><small>{item.label}</small>
          </button>)}
        </nav>
        <div className="rail-foot">GCS / 0.19</div>
      </aside>
      {fleetOpen && <aside className="fleetbar">
        <div className="fleetbar-head"><span>AIRCRAFT</span><strong>{vehicles.length}</strong></div>
        <div className="fleet-search-note">Aircraft directory</div>
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
            const item = readings[v.vehicle_id];
            return <button key={v.vehicle_id} type="button"
              onClick={() => setSelected(v.vehicle_id)}
              className={"aircraft-item " + (selected === v.vehicle_id ? "current" : "")}>
              <div className="aircraft-icon">✈</div><div className="aircraft-info">
                <strong>{v.label}</strong><span>{v.vehicle_id}</span>
                <small className={item?.status === "LIVE" ? "working" : ""}>{linkLabel(item?.status)}</small>
              </div><span className={"aircraft-dot " + (item?.status === "LIVE" ? "online" : "")}/>
            </button>;
          })}
        </div>
        <button className="add-aircraft" onClick={() => navigate("FLEET")}>+ Register aircraft</button>
        <div className="fleetbar-foot">
          <div>ACTIVE STREAMS <b>{liveCount}</b></div>
          <div>OPERATIONS API <b>{health ? "AVAILABLE" : "UNAVAILABLE"}</b></div>
        </div>
      </aside>}
      <div className="main-area">
        <header className="toolbar">
          <div className="toolbar-leading">
            <span className="product-label">VIHANGA / OPERATIONS</span>
            <span className="toolbar-separator">/</span>
            <strong>{section === "PLAN" ? "MISSION PLANNING" : section === "VIDEO" ? "LIVE VIDEO" : section === "LINK" ? "LINK HEALTH" : section === "CONTROL" ? "AIRCRAFT CONTROL" : section}</strong>
            <span className="toolbar-subtitle">{active
              ? active.label + " · " + active.autopilot : "No aircraft selected"}</span>
          </div>
          <div className="toolbar-right">
            <button type="button" className="toolbar-button fleet-toggle"
              aria-label={fleetOpen ? "Hide aircraft list" : "Show aircraft list"}
              aria-pressed={fleetOpen} onClick={() => setFleetOpen(v => !v)}>
              <UiIcon name="fleet" size={15}/> {fleetOpen ? "Hide aircraft" : "Aircraft"}
            </button>
            <span className={"link-chip " + (sample?.status === "LIVE" ? "ok" : "")}>
              <span className="chip-dot"/>{linkLabel(sample?.status)}
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
              disabled={!selected} title="Configure primary or backup telemetry receiver">
              <UiIcon name="radio" size={15}/> Connections
            </button>
          </div>
        </header>
        <div className={"map-stage " + ((section === "FLIGHT" || section === "PLAN") ? "has-operations" : "")}>
          <GeoMap polygon={section === "PLAN" ? polygon : EMPTY_POLYGON} route={section === "PLAN" || section === "HISTORY" ? waypoints : EMPTY_ROUTE}
            track={observedTrack} position={location} drawing={section === "PLAN" && drawMode !== "NONE"}
            basemap={basemap} centerSignal={centerSignal} fitSignal={fitSignal}
            selectedWaypoint={selectedWaypoint} onWaypointSelect={setSelectedWaypoint}
            fitLeftPadding={panelOpen && (section === "PLAN" || section === "HISTORY") ? 414 : 76}
            onMapClick={clicked} onVertexMove={moveVertex}/>
          <div className="map-tools">
            <button className={basemap === "satellite" ? "chosen" : ""} onClick={() => setBasemap("satellite")}>Satellite</button>
            <button className={basemap === "streets" ? "chosen" : ""} onClick={() => setBasemap("streets")}>Streets</button>
            <button disabled={!location} title={!location ? "No fresh GPS fix" : "Center selected aircraft"}
              onClick={() => setCenterSignal(x => x + 1)}>Aircraft</button>
            <button disabled={waypoints.length === 0 && polygon.length === 0}
              title="Fit survey or route to map"
              onClick={() => setFitSignal(x => x + 1)}>Fit route</button>
          </div>
          {section === "PLAN" && <div className="operation-ribbon" role="toolbar" aria-label="Planning tools">
            <button className={section === "PLAN" && drawMode === "POLYGON" ? "active" : ""}
              aria-pressed={section === "PLAN" && drawMode === "POLYGON"}
              onClick={() => { navigate("PLAN"); setDrawMode("POLYGON"); }} title="Draw survey boundary"><UiIcon name="plan" size={15}/> <span>Survey</span></button>
            <button className={section === "PLAN" && drawMode === "WAYPOINT" ? "active" : ""}
              aria-pressed={section === "PLAN" && drawMode === "WAYPOINT"}
              onClick={() => { navigate("PLAN"); setDrawMode("WAYPOINT"); }} title="Add manual waypoints"><UiIcon name="map" size={15}/> <span>Waypoints</span></button>
            <button onClick={() => navigate("HISTORY")} title="View stored mission drafts"><UiIcon name="history" size={15}/> <span>Routes</span></button>
          </div>}
          {!panelOpen && <div className="panel-launcher">
            <button type="button" onClick={() => setPanelOpen(true)}
              aria-expanded={false} aria-controls="operator-panel"
              aria-label="Show operator panel">
              <UiIcon name="map" size={16}/> {section === "PLAN" ? "Edit plan" : "Open panel"}
            </button>
            {section === "PLAN" && waypoints.length > 0 &&
              <span className="route-count">{waypoints.length} waypoint{waypoints.length === 1 ? "" : "s"}</span>}
          </div>}
          {panelOpen && section === "CONTROL" && <ControlPanel
             aircraftId={selected} catalog={operatorCatalog} telemetry={sample}
             readback={parameterReadback} busy={busy}
             onClose={() => setPanelOpen(false)}
             onBenchQuery={(query, parameter) => { void requestBenchRead(query, parameter); }}
             onRefreshReadback={() => { void refreshParameters(); }}
           />}
           {panelOpen && section === "FLIGHT" && <div id="operator-panel" className="float-panel flight-summary">
            <div className="panel-title"><h2>Flight status</h2><span>{active?.label || "No aircraft selected"}</span><button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <div className="status-rows">
              <div><span>Connection</span><strong>{linkLabel(sample?.status)}</strong></div>
              <div><span>Flight mode</span><strong>{sample?.heartbeat_fresh ? sample.mode || "UNKNOWN" : "NO DATA"}</strong></div>
              <div><span>Arm state</span><strong>{sample?.armed == null ? "UNKNOWN" : sample.armed ? "ARMED" : "DISARMED"}</strong></div>
              <div><span>GNSS</span><strong>{sample?.gps_fix_type == null ? "NO FIX DATA" : "FIX " + sample.gps_fix_type + " / " + (sample.satellites ?? "—") + " SAT"}</strong></div>
              <div><span>Telemetry age</span><strong>{sample?.age_ms == null ? "—" : sample.age_ms + " ms"}</strong></div>
              <div><span>FC heartbeat</span><strong>{sample?.heartbeat_fresh ? "RECEIVING" : "MISSING / STALE"}</strong></div>
              <div><span>Observed GNSS points</span><strong>{observedTrack.length}</strong></div>
              <div><span>Local viewer</span><strong>{liveTransportConnected ? "STREAMING" : "HTTP FALLBACK"}</strong></div>
            </div>
            <p className="flight-status-note">Telemetry monitoring <span>·</span> Read-only connection</p>
          </div>}
          {panelOpen && section === "PLAN" && <section id="operator-panel" className="float-panel plan-panel">
            <div className="panel-title">
              <h2>Survey planner</h2>
              <span>{openedMission ? "SAVED DRAFT" : survey ? "PREVIEW READY" : "DRAFT"}</span>
            <button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <div className="plan-intro">
              <span>MISSION GEOMETRY</span>
              <strong>{selected || "NO AIRCRAFT"}</strong>
            </div>
            <div className="plan-tabs" aria-label="Coverage pattern">
              <button type="button" className={pattern === "PARALLEL" ? "active" : ""}
                onClick={() => { setPattern("PARALLEL"); setSurvey(null); setSelectedWaypoint(null); setEditedRoute(null); }}>Parallel</button>
              <button type="button" className={pattern === "CIRCULAR" ? "active" : ""}
                onClick={() => { setPattern("CIRCULAR"); setSurvey(null); setSelectedWaypoint(null); setEditedRoute(null); }}>Circular</button>
            </div>
            <div className="panel-section-label">AREA & WAYPOINTS</div>
            <div className="planner-quick-actions" role="group" aria-label="Planner editing tools">
              <button type="button" onClick={undoPlannerPoint}
                disabled={!!openedMission || !(drawMode === "POLYGON" ? polygon.length : waypoints.length)}
                title="Remove the last route waypoint or polygon vertex">Undo last</button>
              <button type="button" onClick={clearWaypoints} disabled={!waypoints.length}
                title="Clear displayed waypoints without deleting saved missions">Clear waypoints</button>
              <button type="button" onClick={clearBoundary} disabled={!polygon.length}
                title="Remove the survey boundary">Clear boundary</button>
              <button type="button" className="planner-reset" onClick={resetPlanner}
                disabled={!polygon.length && !waypoints.length && !missionTitle}
                title="Reset planner settings and geometry; saved missions remain intact">Reset</button>
            </div>
            <div className="toggle-row compact-row">
              <button type="button" className={drawMode === "POLYGON" ? "active" : ""}
                onClick={() => { setDrawMode(drawMode === "POLYGON" ? "NONE" : "POLYGON"); setOpenedMission(null); }}>
                Draw boundary</button>
              <button type="button" className={drawMode === "WAYPOINT" ? "active" : ""}
                onClick={() => { setDrawMode(drawMode === "WAYPOINT" ? "NONE" : "WAYPOINT"); setOpenedMission(null); }}>
                Add waypoint</button>
            </div>
            {drawMode !== "NONE" && <div className="drawing-note">
              Map editing active · Click to add {drawMode === "POLYGON" ? "survey vertices" : "route waypoints"}.
              Vertices can be dragged on the map.
            </div>}
            <div className="survey-controls">
              <label>Line / ring spacing
                <div className="value-row"><input type="range" min="5" max="100" step="1" value={spacing}
                  onChange={e => {setSpacing(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/>
                  <input className="value-box" type="number" min="5" max="200" value={spacing}
                    onChange={e => {setSpacing(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/><span>m</span></div>
              </label>
              {pattern === "PARALLEL" && <label>Grid angle
                <div className="value-row"><input type="range" min="0" max="179" value={bearing}
                  onChange={e => {setBearing(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/>
                  <input className="value-box" type="number" min="0" max="179" value={bearing}
                    onChange={e => {setBearing(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/><span>°</span></div>
              </label>}
              <label>Flight altitude
                <div className="value-row"><input type="range" min="10" max="120" value={altitude}
                  onChange={e => {setAltitude(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/>
                  <input className="value-box" type="number" min="10" max="120" value={altitude}
                    onChange={e => {setAltitude(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/><span>m</span></div>
              </label>
              <label>Planned groundspeed
                <div className="value-row"><input type="range" min="0.5" max="20" step="0.5" value={speed}
                  onChange={e => {setSpeed(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/>
                  <input className="value-box" type="number" min="0.5" max="25" step="0.5" value={speed}
                    onChange={e => {setSpeed(Number(e.target.value));setSurvey(null);setEditedRoute(null);}}/><span>m/s</span></div>
              </label>
            </div>
            <div className="plan-buttons">
              <button type="button" disabled={!polygon.length && !waypoints.length}
                onClick={() => setFitSignal(v => v+1)}>Fit geometry on map</button>
            </div>
            <button type="button" className="major" disabled={busy || polygon.length < 3}
              onClick={() => void preview()}>{busy ? "Working…" : "Generate coverage route"}</button>
            {survey?.coverage_note && <div className="drawing-note">{survey.coverage_note}</div>}
            {waypoints.length > 0 && <div className="route-editor">
              <div className="route-editor-head">
                <strong>Waypoints <span className="route-total">{waypoints.length}</span></strong>
                <span>{openedMission ? "SAVED ROUTE" : "DRAFT ROUTE"}</span>
              </div>
              <div className="route-scroll" aria-label="Mission waypoint list">
                {waypoints.slice(0,100).map((p,i) => <div
                  className={"route-row" + (selectedWaypoint === i ? " picked" : "")} key={i}>
                  <button type="button" className="waypoint-index"
                    title={"Highlight waypoint " + (i + 1) + " on the map"}
                    aria-label={"Select waypoint " + (i + 1)}
                    aria-pressed={selectedWaypoint === i}
                    onClick={() => setSelectedWaypoint(i)}>{i + 1}</button>
                  <label>LAT<input disabled={!!openedMission} type="number" step="any"
                    defaultValue={p.latitude} onFocus={() => setSelectedWaypoint(i)}
                    onBlur={e => reviseWaypoint(i,"latitude",e.target.value)}/></label>
                  <label>LON<input disabled={!!openedMission} type="number" step="any"
                    defaultValue={p.longitude} onFocus={() => setSelectedWaypoint(i)}
                    onBlur={e => reviseWaypoint(i,"longitude",e.target.value)}/></label>
                  <label>ALT<input disabled={!!openedMission} type="number" min="0" max="120"
                    defaultValue={p.altitude_m} onFocus={() => setSelectedWaypoint(i)}
                    onBlur={e => reviseWaypoint(i,"altitude_m",e.target.value)}/></label>
                </div>)}
                {waypoints.length > 100 && <p className="panel-footnote">Showing first 100 of {waypoints.length} route points</p>}
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
            <p className="panel-footnote">Offline draft. Check terrain, obstacles and airspace before use. No aircraft upload.</p>
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
            <p className="panel-footnote">Aircraft remain offline until their actual telemetry connection is established.</p>
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
            <div className="panel-title"><h2>Saved route history</h2><span>{displayedMissionList.length} drafts</span><button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
            <div className="history-list">
              {displayedMissionList.length === 0 && <p className="panel-footnote">No saved drafts for this aircraft.</p>}
              {displayedMissionList.map(m => <button key={m.mission_id} onClick={() => {
                setOpenedMission(m); setSelectedWaypoint(null);
                setSurvey(null); setManual([]); setPolygon([]);
              }} className={openedMission?.mission_id === m.mission_id ? "picked" : ""}>
                <strong>{m.title}</strong>
                <span>{m.waypoints.length} points · {(m.distance_m / 1000).toFixed(2)} km</span>
                <small>{m.revision_sha256.slice(0, 16)} · DRAFT</small>
              </button>)}
            </div>
            <p className="panel-footnote">This is a real record of stored mission drafts, not a log of flights that did not occur.</p>
          </section>}
          {panelOpen && section === "VIDEO" && <section id="operator-panel" className="float-panel utility-panel video-panel">
            <div className="panel-title"><h2><UiIcon name="video" size={20}/> Camera workstation</h2>
              <span>PRIVATE WEBRTC / {selected || "NO AIRCRAFT"}</span><button type="button" className="panel-close" onClick={() => setPanelOpen(false)} aria-label="Close panel" title="Close panel">×</button></div>
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
            {!cameraUrl && <p className="panel-footnote">Enter an actual authenticated MediaMTX/WebRTC camera page. No stock video is displayed.</p>}
          </section>}
          <div className={"ops-signal-strip" + (diagnosticsOpen ? " drawer-open" : "")}
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
          </div>
          <NetworkWatch aircraftId={selected} telemetry={sample} viewerConnected={liveTransportConnected}/>
          {diagnosticsOpen && <OperationsPanel
            aircraftId={selected} telemetry={sample} busy={busy}
            onClose={() => setDiagnosticsOpen(false)}
            onConfigureBackup={() => openConnection("BACKUP")}
            onSelect={role => { void chooseSource(role); }}
            onRemoveBackup={() => { void stopBackupLink(); }}
          />}
          <div className="map-coordinates">{observedTrack.length > 0
            ? "BLUE: observed GNSS track · AMBER: planned route. Recorded points are not approved flight commands."
            : "Map center is a default view, not an aircraft position. Live position needs fresh GNSS."}</div>
          {alert && <div className="toast error" role="alert">{alert}<button onClick={() => setAlert("")}>×</button></div>}
          {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
        </div>
        <FlightInstruments telemetry={sample}/>
      </div>
      {connectOpen && <ConnectionSettings
        aircraftName={active?.label || "Aircraft"}
        aircraftId={selected}
        telemetry={sample}
        initialRole={connectionRole}
        busy={busy}
        error={connectionError}
        onConnect={startLink}
        onActivate={chooseSource}
        onRemoveBackup={stopBackupLink}
        onDisconnect={stopLink}
        onClose={() => {
          if (!busy) { setConnectOpen(false); setConnectionError(""); }
        }}
      />}
    </div>
  );
}
