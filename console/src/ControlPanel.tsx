import { useMemo, useState } from "react";
import type {
  BenchReadKind, OperatorCatalog, OperatorGroup, ParameterReadback, Telemetry,
} from "./api";

const groups: {key: OperatorGroup; label: string}[] = [
  {key:"FLIGHT", label:"Flight"},
  {key:"NAVIGATION", label:"Navigation"},
  {key:"MISSIONS", label:"Missions"},
  {key:"PARAMETERS", label:"Parameters"},
  {key:"DIAGNOSTICS", label:"Diagnostics"},
  {key:"SETUP", label:"Calibration"},
  {key:"LOGS", label:"Logs"},
];

const arducopterModes = [
  "STABILIZE", "ACRO", "ALT_HOLD", "AUTO", "GUIDED", "LOITER", "RTL",
  "CIRCLE", "LAND", "DRIFT", "SPORT", "FLIP", "AUTOTUNE", "POSHOLD",
  "BRAKE", "THROW", "AVOID_ADSB", "GUIDED_NOGPS", "SMART_RTL",
] as const;

interface Props {
  aircraftId: string;
  catalog: OperatorCatalog | null;
  telemetry?: Telemetry;
  readback: ParameterReadback | null;
  busy: boolean;
  onClose: () => void;
  onBenchQuery: (query: BenchReadKind, parameter?: string) => void;
  onRefreshReadback: () => void;
}

export default function ControlPanel({
  aircraftId, catalog, telemetry, readback, busy,
  onClose, onBenchQuery, onRefreshReadback
}: Props) {
  const [group, setGroup] = useState<OperatorGroup>("FLIGHT");
  const [mode, setMode] = useState("LOITER");
  const [parameter, setParameter] = useState("GPS_TYPE");
  const [search, setSearch] = useState("");
  const entries = catalog?.operations.filter(item => item.group === group) ?? [];
  const listed = useMemo(() => {
    const query = search.trim().toLowerCase();
    return Object.entries(readback?.items ?? {})
      .filter(([name]) => !query || name.toLowerCase().includes(query))
      .slice(0, 120);
  }, [readback, search]);

  return <section id="operator-panel" className="control-panel float-panel"
    aria-label="Flight operations and aircraft configuration">
    <header className="control-head">
      <div>
        <span className="control-eyebrow">VIHANGA / FLIGHT OPERATIONS</span>
        <h2>Aircraft control</h2>
        <small>{aircraftId || "No aircraft"} · {telemetry?.status || "OFFLINE"}</small>
      </div>
      <button className="control-close" type="button"
        aria-label="Close control panel" onClick={onClose}>×</button>
    </header>

    <div className="control-link-summary">
      <div><span>FC HEARTBEAT</span>
        <strong className={telemetry?.heartbeat_fresh ? "control-live" : "control-missing"}>
          {telemetry?.heartbeat_fresh ? "FRESH" : "UNAVAILABLE"}
        </strong>
      </div>
      <div><span>ARM STATE</span>
        <strong className={telemetry?.armed === true ? "control-alert" : ""}>
          {telemetry?.armed == null ? "UNKNOWN" : telemetry.armed ? "ARMED" : "DISARMED"}
        </strong>
      </div>
      <div><span>FLIGHT MODE</span>
        <strong>{telemetry?.heartbeat_fresh ? telemetry.mode || "UNKNOWN" : "—"}</strong>
      </div>
    </div>

    <div className="control-permission" role="status">
      <strong>Flight command path locked</strong>
      <span>Control authority and physical command transport are not yet installed.
        These controls cannot arm, change modes or move the aircraft.</span>
    </div>

    <nav className="control-groups" aria-label="Aircraft operation categories">
      {groups.map(item => <button type="button" key={item.key}
        className={group === item.key ? "active" : ""} aria-pressed={group === item.key}
        onClick={() => setGroup(item.key)}>{item.label}</button>)}
    </nav>

    <div className="control-workarea">
      {group === "NAVIGATION" && <div className="control-mode-select">
        <label htmlFor="operator-mode-choice">ArduCopter mode selection</label>
        <select id="operator-mode-choice" value={mode} onChange={e => setMode(e.target.value)}>
          {arducopterModes.map(value => <option value={value} key={value}>{value}</option>)}
        </select>
        <small>Requested mode: {mode}. Mode changes are unavailable until command authority is validated.</small>
      </div>}

      {group === "PARAMETERS" && <div className="control-parameter-search">
        <label htmlFor="fc-parameter">Parameter name</label>
        <input id="fc-parameter" value={parameter} maxLength={16}
          onChange={e => setParameter(e.target.value.toUpperCase())}
          spellCheck={false} placeholder="GPS_TYPE"/>
      </div>}

      <div className="control-actions">
        {entries.map(action => <button type="button" key={action.code}
          disabled={busy || !action.enabled || (action.code === "PARAM_READ" && !/^[A-Z][A-Z0-9_]{0,15}$/.test(parameter))}
          className={"control-action " +
            (action.risk === "CRITICAL" ? "critical " : action.risk === "HIGH" ? "caution " : "readonly ") +
            (action.enabled ? "enabled" : "locked")}
          title={action.enabled ? "Non-actuating read request via USB serial" :
            "Unavailable: " + action.reason.replaceAll("_", " ").toLowerCase()}
          onClick={() => action.bench_query &&
            onBenchQuery(action.bench_query, action.code === "PARAM_READ" ? parameter : undefined)}>
          <span className="control-action-heading">
            <strong>{action.label}</strong>
            <small>{action.risk === "READ" ? "READ" :
              action.risk === "CRITICAL" ? "FLIGHT" : "RESTRICTED"}</small>
          </span>
          <span className="control-action-state">
            {action.enabled ? "Request data" : "Locked"}
          </span>
        </button>)}
      </div>

      {group === "PARAMETERS" && <div className="control-readback">
        <div className="control-readback-head">
          <div><strong>Observed FC parameters</strong>
            <small>{readback?.received ?? 0} received
              {readback?.reported_total != null ? " / " + readback.reported_total + " reported" : ""}</small>
          </div>
          <button type="button" disabled={busy} onClick={onRefreshReadback}>Refresh view</button>
        </div>
        <label className="control-filter-label" htmlFor="fc-param-filter">Filter received</label>
        <input id="fc-param-filter" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search parameter names"/>
        <div className="control-parameter-list">
          {listed.length === 0 && <p>No FC parameters received. Connect local USB and request a parameter.</p>}
          {listed.map(([key,value]) => <div key={key} className="control-parameter-row">
            <span>{key}</span><strong>{value.value}</strong>
          </div>)}
        </div>
      </div>}
    </div>
    <footer className="control-footnote">
      Local bench reads require an explicit server opt-in and a connected USB serial receiver.
      A completed request write does not mean the FC responded. No command or parameter write is enabled.
    </footer>
  </section>;
}
