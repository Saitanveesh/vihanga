import { useEffect, useMemo, useState, type FormEvent } from "react";
import GeoMap, { type MapPoint } from "./GeoMap";
import FlightInstruments from "./FlightInstruments";
import {
  connectCloud, connectUDP, connectTCP, connectSerial, disconnectLink, getHealth, getMissions,
  getTelemetry, getObservedTrack, getVehicles, previewSurvey, previewCircularSurvey, registerVehicle, saveMission,
  type Health, type Mission, type SurveyPreview, type Telemetry,
  type Vehicle, type VehicleCreate, type Waypoint
} from "./api";

type Section = "FLIGHT" | "PLAN" | "FLEET" | "LINK" | "HISTORY" | "VIDEO";
type DrawMode = "NONE" | "POLYGON" | "WAYPOINT";
const sections: { label: Section; icon: string }[] = [
  { label: "FLIGHT", icon: "◈" }, { label: "PLAN", icon: "⌖" },
  { label: "FLEET", icon: "▦" }, { label: "LINK", icon: "⇄" },
  { label: "HISTORY", icon: "◷" }, { label: "VIDEO", icon: "▣" }
];

function linkLabel(status?: string) {
  return status === "LIVE" ? "LIVE TELEMETRY" :
    status === "PARTIAL" ? "PARTIAL TELEMETRY" :
    status === "STALE" ? "STALE DATA" :
    status === "CONNECTING" ? "CONNECTING" :
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
  const [aircraftSearch, setAircraftSearch] = useState("");
  const [aircraftFilter, setAircraftFilter] = useState<"ALL" | "LIVE" | "OFFLINE">("ALL");
  const [spacing, setSpacing] = useState(20);
  const [bearing, setBearing] = useState(0);
  const [altitude, setAltitude] = useState(35);
  const [missionTitle, setMissionTitle] = useState("");
  const [openedMission, setOpenedMission] = useState<Mission | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [linkType, setLinkType] = useState<"CLOUD" | "UDP" | "TCP" | "SERIAL">("CLOUD");
  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [port, setPort] = useState(14550);
  const [serialPort, setSerialPort] = useState("COM3");
  const [serialBaud, setSerialBaud] = useState(57600);
  const [sysid, setSysid] = useState(1);
  const [cameraInput, setCameraInput] = useState("");
  const [cameraUrl, setCameraUrl] = useState("");

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
    async function poll() {
      const pairs = await Promise.all(vehicles.map(async v => {
        try { return [v.vehicle_id, await getTelemetry(v.vehicle_id)] as const; }
        catch { return null; }
      }));
      if (mounted) {
        const next: Record<string, Telemetry> = {};
        pairs.forEach(pair => { if (pair) next[pair[0]] = pair[1]; });
        setReadings(next);
      }
    }
    void poll();
    const handle = window.setInterval(() => void poll(), 1600);
    return () => { mounted = false; window.clearInterval(handle); };
  }, [vehicles]);


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
    setSection(page);
    setDrawMode("NONE");
    setAlert(""); setNotice("");
  }
  function clicked(point: MapPoint) {
    if (section !== "PLAN") return;
    setOpenedMission(null);
    setSurvey(null);
    setEditedRoute(null);
    if (drawMode === "POLYGON") setPolygon(old => [...old, point]);
    if (drawMode === "WAYPOINT") setManual(old => [...old, { ...point, altitude_m: altitude }]);
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
      setSurvey(null); setEditedRoute(null); setPolygon([]); setManual([]); setMissionTitle("");
      setDrawMode("NONE");
      await refresh();
      notify("Saved draft " + draft.revision_sha256.slice(0, 12) + ". No flight-controller upload occurred.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  async function startLink(event: FormEvent) {
    event.preventDefault();
    if (!selected) return fail(new Error("Register and select an aircraft first"));
    setBusy(true);
    try {
      let result: Telemetry;
      if (linkType === "CLOUD") result = await connectCloud({vehicle_id:selected,origin,username,password,fc_system_id:sysid});
      else if (linkType === "SERIAL") result = await connectSerial({vehicle_id:selected,port:serialPort.trim(),baud:serialBaud,fc_system_id:sysid});
      else if (linkType === "TCP") result = await connectTCP({vehicle_id:selected,port,fc_system_id:sysid});
      else result = await connectUDP({vehicle_id:selected,port,fc_system_id:sysid});
      setReadings(old => ({ ...old, [selected]: result }));
      setConnectOpen(false);
      setPassword("");
      notify(linkType === "CLOUD"
        ? "Private cloud viewer requested. Awaiting verified flight-controller MAVLink."
        : linkType === "SERIAL"
          ? "Read-only serial receiver opened on " + serialPort + "."
          : linkType === "TCP"
            ? "Read-only TCP receiver connected to 127.0.0.1:" + port + "."
            : "Local UDP listener bound to 127.0.0.1:" + port + ".");
    } catch (e) { fail(e); } finally { setBusy(false); setPassword(""); }
  }
  async function stopLink() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await disconnectLink(selected);
      setReadings(old => ({ ...old, [selected]: result }));
      notify("Aircraft telemetry receiver disconnected.");
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  function setVideo(event: FormEvent) {
    event.preventDefault();
    try {
      const parsed = new URL(cameraInput);
      if (parsed.protocol !== "https:" || !parsed.hostname.toLowerCase().endsWith(".ts.net")
          || parsed.username || parsed.password) {
        throw new Error("For development, camera URL must be a private HTTPS *.ts.net endpoint");
      }
      setCameraUrl(parsed.href);
      notify("Camera page selected. Video availability depends on the actual stream endpoint.");
    } catch (e) { fail(e); }
  }

  return (
    <div className="workspace">
      <aside className="rail">
        <div className="identity"><span>V</span><b>VIHANGA</b></div>
        <nav aria-label="Workspaces">
          {sections.map(item => <button key={item.label} type="button"
            className={"rail-item " + (section === item.label ? "selected" : "")}
            onClick={() => navigate(item.label)} aria-current={section === item.label ? "page" : undefined}>
            <span className="rail-icon">{item.icon}</span><small>{item.label}</small>
          </button>)}
        </nav>
        <div className="rail-foot">GCS / 0.2</div>
      </aside>
      <aside className="fleetbar">
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
      </aside>
      <div className="main-area">
        <header className="toolbar">
          <div className="toolbar-leading">
            <span className="product-label">VIHANGA / OPERATIONS</span>
            <span className="toolbar-separator">/</span>
            <strong>{section === "PLAN" ? "MISSION PLANNING" : section}</strong>
            <span className="toolbar-subtitle">{active?.label || "No aircraft selected"}</span>
          </div>
          <div className="toolbar-right">
            <span className={"link-chip " + (sample?.status === "LIVE" ? "ok" : "")}>
              <span className="chip-dot"/>{linkLabel(sample?.status)}
            </span>
            <span className="vehicle-chip">{active?.vehicle_id || "NO AIRCRAFT"}</span>
            <button className="toolbar-button accent" onClick={() => setConnectOpen(true)}
              disabled={!selected} title="Connect authenticated receive-only telemetry">Connect ↗</button>
          </div>
        </header>
        <div className="map-stage">
          <GeoMap polygon={section === "PLAN" ? polygon : []} route={section === "PLAN" || section === "HISTORY" ? waypoints : []}
            track={observedTrack} position={location} drawing={section === "PLAN" && drawMode !== "NONE"}
            basemap={basemap} centerSignal={centerSignal} fitSignal={fitSignal}
            onMapClick={clicked} onVertexMove={moveVertex}/>
          <div className="map-tools">
            <button className={basemap === "satellite" ? "chosen" : ""} onClick={() => setBasemap("satellite")}>Satellite</button>
            <button className={basemap === "streets" ? "chosen" : ""} onClick={() => setBasemap("streets")}>Streets</button>
            <button disabled={!location} title={!location ? "No fresh GPS fix" : "Center selected aircraft"}
              onClick={() => setCenterSignal(x => x + 1)}>Aircraft</button>
            <button disabled={waypoints.length < 2 && polygon.length < 3}
              title="Fit survey or route to map"
              onClick={() => setFitSignal(x => x + 1)}>Fit route</button>
          </div>
          {(section === "FLIGHT" || section === "PLAN") && <div className="operation-ribbon" role="toolbar" aria-label="Mission and aircraft operations">
            <button onClick={() => { navigate("PLAN"); setDrawMode("POLYGON"); }} title="Draw survey boundary">▦ <span>Survey</span></button>
            <button onClick={() => { navigate("PLAN"); setDrawMode("WAYPOINT"); }} title="Add manual waypoints">⌖ <span>Waypoints</span></button>
            <button onClick={() => navigate("HISTORY")} title="View stored mission drafts">◷ <span>Routes</span></button>
            <span className="ribbon-divider"/>
            <button disabled title="ARM requires an authorized physical command link">ARM</button>
            <button disabled title="TAKEOFF requires an authorized physical command link">TAKEOFF</button>
            <button disabled title="RTL requires an authorized physical command link">RTL</button>
            <button disabled title="LAND requires an authorized physical command link">LAND</button>
            <span className="ribbon-state">COMMANDS LOCKED</span>
          </div>}
          {section === "FLIGHT" && <div className="float-panel flight-summary">
            <div className="panel-title"><h2>Flight status</h2><span>{active?.label || "No aircraft selected"}</span></div>
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
            <p className="panel-footnote">Only validated, fresh MAVLink telemetry is shown. Aircraft control is unavailable in this software release.</p>
          </div>}
          {section === "PLAN" && <section className="float-panel plan-panel">
            <div className="panel-title">
              <h2>Survey planner</h2>
              <span>{openedMission ? "SAVED DRAFT" : survey ? "PREVIEW READY" : "DRAFT"}</span>
            </div>
            <div className="plan-tabs" aria-label="Coverage pattern">
              <button type="button" className={pattern === "PARALLEL" ? "active" : ""}
                onClick={() => { setPattern("PARALLEL"); setSurvey(null); setEditedRoute(null); }}>Parallel</button>
              <button type="button" className={pattern === "CIRCULAR" ? "active" : ""}
                onClick={() => { setPattern("CIRCULAR"); setSurvey(null); setEditedRoute(null); }}>Circular</button>
            </div>
            <div className="panel-section-label">MISSION GEOMETRY</div>
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
              <button type="button" onClick={() => {
                if (drawMode === "POLYGON") setPolygon(p => p.slice(0,-1));
                if (drawMode === "WAYPOINT") setManual(p => p.slice(0,-1));
                setSurvey(null);setEditedRoute(null);setOpenedMission(null);
              }}>Undo</button>
              <button type="button" onClick={() => {
                setPolygon([]);setManual([]);setSurvey(null);setEditedRoute(null);
                setOpenedMission(null);setDrawMode("NONE");
              }}>Clear area</button>
              <button type="button" disabled={!polygon.length && !waypoints.length}
                onClick={() => setFitSignal(v => v+1)}>Fit map</button>
            </div>
            <button type="button" className="major" disabled={busy || polygon.length < 3}
              onClick={() => void preview()}>{busy ? "Working…" : "Generate coverage route"}</button>
            <div className="plan-stats">
              <div><span>Boundary vertices</span><strong>{polygon.length}</strong></div>
              <div><span>{pattern === "CIRCULAR" ? "Concentric rings" : "Flight lines"}</span><strong>{survey?.lane_count ?? "—"}</strong></div>
              <div><span>Route waypoints</span><strong>{waypoints.length}</strong></div>
              <div><span>Route distance</span><strong>{survey ? (survey.route_distance_m/1000).toFixed(2) + " km" : "—"}</strong></div>
              <div><span>Travel time estimate</span><strong>{survey ? (survey.estimated_duration_s/60).toFixed(1) + " min" : "—"}</strong></div>
            </div>
            {survey?.coverage_note && <div className="drawing-note">{survey.coverage_note}</div>}
            {waypoints.length > 0 && <div className="route-editor">
              <div className="route-editor-head">
                <strong>Waypoints ({waypoints.length})</strong>
                <span>{openedMission ? "READ ONLY" : "EDITABLE"}</span>
              </div>
              <div className="route-scroll">
                {waypoints.slice(0,100).map((p,i) => <div className="route-row" key={i}>
                  <span className="waypoint-index">{i+1}</span>
                  <label>LAT<input disabled={!!openedMission} type="number" step="any"
                    defaultValue={p.latitude} onBlur={e => reviseWaypoint(i,"latitude",e.target.value)}/></label>
                  <label>LON<input disabled={!!openedMission} type="number" step="any"
                    defaultValue={p.longitude} onBlur={e => reviseWaypoint(i,"longitude",e.target.value)}/></label>
                  <label>ALT<input disabled={!!openedMission} type="number" min="0" max="120"
                    defaultValue={p.altitude_m} onBlur={e => reviseWaypoint(i,"altitude_m",e.target.value)}/></label>
                </div>)}
                {waypoints.length > 100 && <p className="panel-footnote">Showing first 100 of {waypoints.length} route points</p>}
              </div>
            </div>}
            <div className="export-actions">
              <button type="button" onClick={exportDraftGeoJSON} disabled={waypoints.length < 2}>Export GeoJSON</button>
            </div>
            <form className="save-form" onSubmit={e => void saveDraft(e)}>
              <label>Mission name<input required minLength={3} maxLength={100}
                placeholder="Boundary survey · Site 01" value={missionTitle}
                onChange={e => setMissionTitle(e.target.value)}/></label>
              <button type="submit" className="major" disabled={busy || waypoints.length < 2 || !selected || !!openedMission}>Save mission draft</button>
            </form>
            <p className="panel-footnote">Route geometry and estimates are calculated, not simulated. No airspace, terrain, turning-radius or obstacle clearance has been verified. No mission upload occurs.</p>
          </section>}
          {section === "FLEET" && <section className="float-panel utility-panel">
            <div className="panel-title"><h2>Aircraft registry</h2><span>{vehicles.length} registered</span></div>
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
          {section === "LINK" && <section className="float-panel utility-panel">
            <div className="panel-title"><h2>Connection diagnostics</h2><span>Receive-only</span></div>
            <div className="status-rows">
              <div><span>Selected aircraft</span><strong>{selected || "—"}</strong></div>
              <div><span>Transport</span><strong>{sample?.transport || "NONE"}</strong></div>
              <div><span>Status</span><strong>{linkLabel(sample?.status)}</strong></div>
              <div><span>Frames received</span><strong>{sample?.frames_total ?? 0}</strong></div>
              <div><span>Observed track points</span><strong>{observedTrack.length}</strong></div>
              <div><span>Local telemetry viewer</span><strong>{liveTransportConnected ? "WEBSOCKET ACTIVE" : "POLLING"}</strong></div>
              <div><span>Rejected frames</span><strong>{sample?.rejected_frames ?? 0}</strong></div>
              <div><span>Last packet age</span><strong>{sample?.age_ms == null ? "—" : sample.age_ms + " ms"}</strong></div>
              <div><span>Receiver error</span><strong>{sample?.error_code || "—"}</strong></div>
            </div>
            <div className="plan-buttons">
              <button className="major" disabled={!selected} onClick={() => setConnectOpen(true)}>Connect aircraft</button>
              <button disabled={!sample || sample.status === "OFFLINE" || busy} onClick={() => void stopLink()}>Disconnect</button>
            </div>
            <p className="panel-footnote">Cloud uses authenticated private WSS; UDP accepts SITL frames only on localhost. Neither transport forwards commands to an FC.</p>
          </section>}
          {section === "HISTORY" && <section className="float-panel utility-panel history-panel">
            <div className="panel-title"><h2>Saved route history</h2><span>{displayedMissionList.length} drafts</span></div>
            <div className="history-list">
              {displayedMissionList.length === 0 && <p className="panel-footnote">No saved drafts for this aircraft.</p>}
              {displayedMissionList.map(m => <button key={m.mission_id} onClick={() => {
                setOpenedMission(m); setSurvey(null); setManual([]); setPolygon([]);
              }} className={openedMission?.mission_id === m.mission_id ? "picked" : ""}>
                <strong>{m.title}</strong>
                <span>{m.waypoints.length} points · {(m.distance_m / 1000).toFixed(2)} km</span>
                <small>{m.revision_sha256.slice(0, 16)} · DRAFT</small>
              </button>)}
            </div>
            <p className="panel-footnote">This is a real record of stored mission drafts, not a log of flights that did not occur.</p>
          </section>}
          {section === "VIDEO" && <section className="float-panel utility-panel video-panel">
            <div className="panel-title"><h2>Camera</h2><span>Independent video path</span></div>
            <form onSubmit={setVideo} className="form-stack">
              <label>Private stream page (HTTPS)<input value={cameraInput} type="url" required
                placeholder="https://aircraft.ts.net/cam"
                onChange={e => setCameraInput(e.target.value)}/></label>
              <button className="major" type="submit">Open camera</button>
            </form>
            {cameraUrl && <div className="video-container">
              <iframe title="Authenticated aircraft camera" src={cameraUrl}
                referrerPolicy="no-referrer" allow="autoplay; fullscreen"/>
              <a href={cameraUrl} target="_blank" rel="noreferrer">Open camera in separate window</a>
            </div>}
            {!cameraUrl && <p className="panel-footnote">Enter an actual authenticated MediaMTX/WebRTC camera page. No stock video is displayed.</p>}
          </section>}
          <div className="map-coordinates">{observedTrack.length > 0
            ? "BLUE: observed GNSS track · AMBER: planned route. Recorded points are not approved flight commands."
            : "Map center is a default view, not an aircraft position. Live position needs fresh GNSS."}</div>
          {alert && <div className="toast error" role="alert">{alert}<button onClick={() => setAlert("")}>×</button></div>}
          {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice("")}>×</button></div>}
        </div>
        <FlightInstruments telemetry={sample}/>
      </div>
      {connectOpen && <div className="modal-backdrop" onClick={e => {
        if (e.currentTarget === e.target) { setConnectOpen(false); setPassword(""); }
      }}>
        <section className="connect-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-title">
          <div className="dialog-head"><div><h2 id="connect-title">Connect aircraft</h2><p>{active?.label} · {selected}</p></div>
            <button type="button" onClick={() => { setConnectOpen(false); setPassword(""); }}>×</button></div>
          <div className="transport-tabs four">
            <button type="button" className={linkType === "CLOUD" ? "active" : ""} onClick={() => setLinkType("CLOUD")}>Cloud</button>
            <button type="button" className={linkType === "SERIAL" ? "active" : ""} onClick={() => setLinkType("SERIAL")}>Serial / USB</button>
            <button type="button" className={linkType === "UDP" ? "active" : ""} onClick={() => setLinkType("UDP")}>UDP</button>
            <button type="button" className={linkType === "TCP" ? "active" : ""} onClick={() => setLinkType("TCP")}>TCP</button>
          </div>
          <form onSubmit={e => void startLink(e)} className="form-stack">
            {linkType === "CLOUD" ? <>
              <label>Private relay origin<input type="url" required placeholder="https://host.ts.net:8443"
                value={origin} onChange={e => setOrigin(e.target.value)}/></label>
              <label>Operator username<input required value={username}
                onChange={e => setUsername(e.target.value)}/></label>
              <label>Operator password<input required type="password" autoComplete="off"
                value={password} onChange={e => setPassword(e.target.value)}/></label>
            </> : linkType === "SERIAL" ? <>
              <label>Serial port<input required placeholder="COM3"
                value={serialPort} onChange={e => setSerialPort(e.target.value)}/></label>
              <label>Baud rate<select value={serialBaud}
                onChange={e => setSerialBaud(Number(e.target.value))}>
                  {[9600,19200,38400,57600,115200,230400,460800,921600].map(baud =>
                    <option key={baud} value={baud}>{baud}</option>)}
                </select></label>
            </> : <label>{linkType === "TCP" ? "Local TCP port" : "Local UDP listen port"}
              <input required type="number" min="1024" max="65535" value={port}
                onChange={e => setPort(Number(e.target.value))}/></label>}
            <label>FC MAVLink system ID<input type="number" min="1" max="254"
              value={sysid} onChange={e => setSysid(+e.target.value)}/></label>
            <p className="dialog-info">{linkType === "CLOUD"
              ? "Private viewer credentials are held for this session only. Connect your PC to the approved Tailscale network."
              : linkType === "SERIAL"
                ? "Vihanga reads the FC serial stream locally. Close other applications holding the same COM port."
                : "Connection restricted to 127.0.0.1. Use a local SITL or authorized telemetry endpoint."}
              {" "}All connection types are receive-only and do not send flight commands.</p>
            <button className="major" disabled={busy || !selected} type="submit">
              {busy ? "Connecting…" : "Start telemetry connection"}</button>
          </form>
        </section>
      </div>}
    </div>
  );
}
