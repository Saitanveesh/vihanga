import { useEffect, useState, type FormEvent } from "react";
import {
  getHealth, getMissions, getVehicles, registerVehicle, saveMission,
  type Health, type Mission, type Vehicle, type VehicleCreate
} from "./api";

type View = "FLIGHT" | "MISSIONS" | "FLEET" | "VISION" | "LINK" | "OPERATIONS" | "SECURITY";
type PointInput = { latitude: string; longitude: string; altitude_m: string };
const sections: { name: View; glyph: string }[] = [
  { name: "FLIGHT", glyph: "⌁" }, { name: "MISSIONS", glyph: "◇" },
  { name: "FLEET", glyph: "▦" }, { name: "VISION", glyph: "◉" },
  { name: "LINK", glyph: "⇆" }, { name: "OPERATIONS", glyph: "≡" },
  { name: "SECURITY", glyph: "▣" }
];
const emptyPoint = (): PointInput => ({ latitude: "", longitude: "", altitude_m: "30" });

export default function App() {
  const [view, setView] = useState<View>("FLIGHT");
  const [health, setHealth] = useState<Health | null>(null);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [newVehicle, setNewVehicle] = useState<VehicleCreate>({
    vehicle_id: "", label: "", autopilot: "ARDUPILOT", interface: "UART"
  });
  const [missionTitle, setMissionTitle] = useState("");
  const [waypoints, setWaypoints] = useState<PointInput[]>([emptyPoint(), emptyPoint()]);

  async function refresh() {
    try {
      const [h, v, m] = await Promise.all([getHealth(), getVehicles(), getMissions()]);
      setHealth(h);
      setVehicles(v);
      setMissions(m);
      setSelected(current => current || (v[0]?.vehicle_id || ""));
      setError("");
    } catch (exc) {
      setHealth(null);
      setError(exc instanceof Error ? exc.message : String(exc));
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function addVehicle(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await registerVehicle({ ...newVehicle, vehicle_id: newVehicle.vehicle_id.trim().toUpperCase(), label: newVehicle.label.trim() });
      setNotice("Aircraft registered. Connection remains OFFLINE until an authenticated edge link is commissioned.");
      setNewVehicle({ vehicle_id: "", label: "", autopilot: "ARDUPILOT", interface: "UART" });
      await refresh();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  async function createDraft(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (!selected) throw new Error("Register and select an aircraft first.");
      const points = waypoints.map(p => ({
        latitude: Number(p.latitude), longitude: Number(p.longitude), altitude_m: Number(p.altitude_m)
      }));
      if (waypoints.some(p => p.latitude.trim() === "" || p.longitude.trim() === "" || p.altitude_m.trim() === "") ||
          points.some(p => !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) || !Number.isFinite(p.altitude_m))) {
        throw new Error("Enter valid numeric coordinates and altitude for every waypoint.");
      }
      const saved = await saveMission({ vehicle_id: selected, title: missionTitle.trim(), waypoints: points });
      setNotice("Mission draft saved as revision " + saved.revision_sha256.slice(0, 12) + ". Not uploaded to any aircraft.");
      setMissionTitle("");
      setWaypoints([emptyPoint(), emptyPoint()]);
      await refresh();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  }

  function updatePoint(index: number, field: keyof PointInput, value: string) {
    setWaypoints(previous => previous.map((p, i) => i === index ? { ...p, [field]: value } : p));
  }

  const active = vehicles.find(v => v.vehicle_id === selected);
  const draftsForAircraft = missions.filter(m => m.vehicle_id === selected);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandmark">V</div>
          <div><strong>VIHANGA</strong><small>GROUND CONTROL SYSTEM</small></div>
        </div>
        <div className="group-label">OPERATIONS</div>
        <nav aria-label="Primary navigation">
          {sections.map(item => (
            <button type="button" key={item.name} className={view === item.name ? "nav active" : "nav"}
              onClick={() => { setView(item.name); setNotice(""); setError(""); }}>
              <span className="navicon">{item.glyph}</span>{item.name}
            </button>
          ))}
        </nav>
        <div className="sidebottom">
          <div className="dim-label">DEPLOYMENT PROFILE</div>
          <div className="side-status"><span className="status-dot amber" /> LOCAL DEVELOPMENT</div>
          <p>No flight-control capability is active in this build.</p>
          <span className="version">VIHANGA STANDALONE · 0.1.0</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="crumb">VIHANGA <span>/</span> {view}</div>
          <div className="top-actions">
            <span className="label-pill muted"><span className="status-dot" /> NO LIVE MAVLINK</span>
            <span className="label-pill">FLIGHT CONTROL DISABLED</span>
            <button type="button" className="refresh" onClick={() => void refresh()}>Refresh</button>
          </div>
        </header>
        <div className="content">
          <div className="page-heading">
            <div><div className="eyebrow">OPERATIONS CONSOLE / V1 FOUNDATION</div>
              <h1>{view === "FLIGHT" ? "Flight overview" : view === "MISSIONS" ? "Mission planning" :
                view === "FLEET" ? "Aircraft registry" : view === "VISION" ? "Video systems" :
                view === "LINK" ? "Connectivity" : view === "OPERATIONS" ? "Operations" : "Security posture"}</h1>
              <p>{view === "FLIGHT" ? "Live data is displayed only after an authenticated aircraft connection." :
                view === "MISSIONS" ? "Compose and preserve route drafts without sending aircraft commands." :
                view === "FLEET" ? "Register aircraft identities. Registration is not a live connection." :
                "System information reflects implemented capabilities, not simulated operation."}</p>
            </div>
            {vehicles.length > 0 && <label className="aircraft-select">SELECT AIRCRAFT
              <select value={selected} onChange={e => setSelected(e.target.value)}>
                {vehicles.map(v => <option key={v.vehicle_id} value={v.vehicle_id}>{v.label} / {v.vehicle_id}</option>)}
              </select>
            </label>}
          </div>
          {error && <div role="alert" className="alert error">{error}</div>}
          {notice && <div role="status" className="alert notice">{notice}</div>}

          {view === "FLIGHT" && <>
            <div className="metric-grid">
              <div className="metric"><small>VEHICLE LINK</small><strong>OFFLINE</strong><span>No authenticated edge session</span></div>
              <div className="metric"><small>ACTIVE AIRCRAFT</small><strong>0</strong><span>{vehicles.length} registered locally</span></div>
              <div className="metric"><small>MISSION DRAFTS</small><strong>{missions.length}</strong><span>Local records only</span></div>
              <div className="metric"><small>COMMAND AUTHORITY</small><strong>NONE</strong><span>Disabled in this development build</span></div>
            </div>
            <div className="panel-grid">
              <section className="panel flight-panel">
                <div className="panel-head"><h2>Primary flight display</h2><span className="muted-text">NO TELEMETRY</span></div>
                <div className="horizon"><div className="horizon-line"/><div className="reticle">+</div>
                  <div className="horizon-caption">FLIGHT ATTITUDE UNAVAILABLE</div></div>
                <div className="readouts">
                  {["ROLL","PITCH","YAW","ALTITUDE","SPEED","BATTERY"].map(v =>
                    <div key={v}><small>{v}</small><strong>—</strong></div>)}
                </div>
              </section>
              <section className="panel">
                <div className="panel-head"><h2>Aircraft status</h2><span className="muted-text">NOT CONNECTED</span></div>
                <div className="vehicle-name">{active?.label || "No aircraft selected"}</div>
                <div className="facts">
                  <div><span>Vehicle ID</span><b>{active?.vehicle_id || "—"}</b></div>
                  <div><span>Autopilot</span><b>{active?.autopilot || "—"}</b></div>
                  <div><span>GPS / Home</span><b>UNKNOWN</b></div>
                  <div><span>FC heartbeat</span><b>NOT RECEIVED</b></div>
                  <div><span>Flight mode</span><b>UNKNOWN</b></div>
                  <div><span>Link source</span><b>NONE</b></div>
                </div>
                <h3>Flight actions</h3>
                <div className="controls">{["ARM","TAKE OFF","LAND","RETURN HOME"].map(name =>
                  <button disabled key={name} title="Flight control has not been implemented or approved">{name}</button>)}</div>
                <p className="safety-note">Controls are intentionally unavailable. No flight-command endpoint exists.</p>
              </section>
            </div>
          </>}

          {view === "FLEET" && <div className="panel-grid">
            <section className="panel">
              <div className="panel-head"><h2>Registered aircraft</h2><span className="muted-text">{vehicles.length} RECORDS</span></div>
              {vehicles.length === 0 ? <div className="empty">No aircraft registered yet.</div> :
                <div className="table-scroll"><table><thead><tr><th>Aircraft</th><th>Autopilot</th><th>Interface</th><th>State</th></tr></thead>
                  <tbody>{vehicles.map(v => <tr key={v.vehicle_id}><td><b>{v.label}</b><small>{v.vehicle_id}</small></td><td>{v.autopilot}</td><td>{v.interface}</td><td><span className="offline">OFFLINE</span></td></tr>)}</tbody>
                </table></div>}
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Register an aircraft</h2></div>
              <form onSubmit={e => void addVehicle(e)} className="form-stack">
                <label>Aircraft identifier<input required pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}" placeholder="AH-HW-001"
                  value={newVehicle.vehicle_id} onChange={e => setNewVehicle({ ...newVehicle, vehicle_id: e.target.value.toUpperCase() })}/></label>
                <label>Display name<input required minLength={3} maxLength={80} placeholder="Test aircraft"
                  value={newVehicle.label} onChange={e => setNewVehicle({ ...newVehicle, label: e.target.value })}/></label>
                <div className="form-row"><label>Autopilot<select value={newVehicle.autopilot}
                  onChange={e => setNewVehicle({ ...newVehicle, autopilot: e.target.value as VehicleCreate["autopilot"] })}>
                  <option>ARDUPILOT</option><option>PX4</option><option>OTHER</option></select></label>
                <label>Physical interface<select value={newVehicle.interface}
                  onChange={e => setNewVehicle({ ...newVehicle, interface: e.target.value as VehicleCreate["interface"] })}>
                  <option>UART</option><option>USB</option><option>ETHERNET</option><option>OTHER</option></select></label></div>
                <button type="submit" className="primary" disabled={busy}>Register aircraft</button>
                <p className="safety-note">Registers metadata only. No cloud session, serial port or vehicle command is opened.</p>
              </form>
            </section>
          </div>}

          {view === "MISSIONS" && <div className="panel-grid mission-layout">
            <section className="panel">
              <div className="panel-head"><h2>New route draft</h2><span className="offline">NOT FOR EXECUTION</span></div>
              <form onSubmit={e => void createDraft(e)} className="form-stack">
                <label>Mission title<input required minLength={3} maxLength={100} placeholder="Perimeter survey"
                  value={missionTitle} onChange={e => setMissionTitle(e.target.value)}/></label>
                <div className="waypoint-header"><h3>Waypoints</h3><button type="button" onClick={() => setWaypoints(p => p.length < 200 ? [...p, emptyPoint()] : p)}>+ Add waypoint</button></div>
                <div className="table-scroll"><table className="wp-table"><thead><tr><th>#</th><th>Latitude</th><th>Longitude</th><th>Alt. m</th><th></th></tr></thead>
                <tbody>{waypoints.map((p, i) => <tr key={i}>
                  <td>{i + 1}</td>
                  {(["latitude","longitude","altitude_m"] as const).map(field => <td key={field}><input required type="number" step="any" value={p[field]} onChange={e => updatePoint(i, field, e.target.value)}/></td>)}
                  <td><button type="button" className="remove" disabled={waypoints.length <= 2} onClick={() => setWaypoints(rows => rows.filter((_, j) => j !== i))}>×</button></td>
                </tr>)}</tbody></table></div>
                <button type="submit" disabled={busy || !selected} className="primary">Save mission draft</button>
                <p className="safety-note">Geographic limits, airspace restrictions, endurance and collision risks are NOT verified. Saving a draft never uploads a mission.</p>
              </form>
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Saved missions</h2><span className="muted-text">{draftsForAircraft.length} FOR SELECTED AIRCRAFT</span></div>
              {draftsForAircraft.length === 0 ? <div className="empty">No drafts for the selected aircraft.</div> :
                <div className="draft-list">{draftsForAircraft.map(m => <div className="draft" key={m.mission_id}>
                  <strong>{m.title}</strong><span>{m.waypoints.length} waypoints · {(m.distance_m/1000).toFixed(2)} km · DRAFT</span>
                  <code>SHA256 {m.revision_sha256.slice(0, 20)}…</code>
                </div>)}</div>}
              <div className="divider"/>
              <h3>Planning boundary</h3><p className="safety-note">Routes are stored with immutable revision digests. Upload, validation against a real flight envelope and execution are not enabled.</p>
            </section>
          </div>}

          {view === "LINK" && <section className="panel narrow"><div className="panel-head"><h2>Transport channels</h2></div>
            <div className="facts"><div><span>Operations API</span><b>{health ? "LOCAL / AVAILABLE" : "UNAVAILABLE"}</b></div>
            <div><span>Aircraft edge agent</span><b>NOT CONFIGURED</b></div>
            <div><span>Cloud relay</span><b>NOT CONNECTED</b></div>
            <div><span>MAVLink receive</span><b>NOT CONFIGURED</b></div>
            <div><span>Physical command path</span><b>DISABLED</b></div></div>
            <p className="safety-note">This standalone rewrite does not inherit the old Raspberry Pi or Oracle services. They remain unaffected.</p></section>}

          {view === "VISION" && <section className="panel narrow"><div className="panel-head"><h2>Video feed</h2></div>
            <div className="video-empty"><div className="video-symbol">◉</div><strong>NO CAMERA STREAM</strong><span>No authenticated video source is configured.</span></div>
            <p className="safety-note">Video transport will be integrated independently of the flight-command channel.</p></section>}

          {view === "OPERATIONS" && <section className="panel narrow"><div className="panel-head"><h2>Operation records</h2></div>
            <div className="metric-grid compact"><div className="metric"><small>AIRCRAFT ONLINE</small><strong>0</strong></div>
              <div className="metric"><small>MISSION DRAFTS</small><strong>{missions.length}</strong></div></div>
            <p className="safety-note">No mission has been dispatched. Approval, scheduling, audit and supervised execution will require an authenticated command service.</p></section>}

          {view === "SECURITY" && <section className="panel narrow"><div className="panel-head"><h2>Development security boundary</h2></div>
            <div className="facts"><div><span>Backend bind scope</span><b>127.0.0.1 ONLY</b></div>
            <div><span>Operator authentication</span><b>NOT IMPLEMENTED</b></div>
            <div><span>Per-aircraft command lease</span><b>NOT IMPLEMENTED</b></div>
            <div><span>Command dispatch</span><b>DISABLED / NO ENDPOINT</b></div>
            <div><span>Production deployment</span><b>NOT AUTHORIZED</b></div></div>
            <p className="safety-note">Never expose this development backend to a public interface. Production identity, authorization and device attestation are required first.</p></section>}
        </div>
        <footer><span>VIHANGA / STANDALONE ENGINEERING BUILD</span><span>LIVE AIRCRAFT CONTROL: DISABLED</span></footer>
      </main>
    </div>
  );
}
