import { useEffect, useState } from "react";
import {
  benchDurations, getBenchCaptures, getBenchReport, startBenchCapture, stopBenchCapture,
  type BenchCapture, type BenchDuration, type BenchReceiver, type BenchReport, type BenchRole, type Telemetry
} from "./api";
import "./Bench.css";

const roles = ["primary", "backup"] as const;
const roleLabel = { primary: "Primary", backup: "Backup", active_source: "Viewer source" };
const transports: Record<string, string> = {
  VIHANGA_CLOUD_V2: "Vihanga Cloud", PRIVATE_CLOUD_WSS: "Private relay",
  DIRECT_LAN_WSS: "Direct Wi-Fi", LOCAL_SERIAL_RECEIVE: "Server USB",
  LOCAL_TCP_RECEIVE: "Local TCP", LOCAL_UDP_SITL: "Local UDP", BROWSER_SERIAL_READ_ONLY: "This PC USB"
};
const findings = {
  EDGE_UPLINK_OFFLINE: "Pi uplink disconnected",
  UART_WAITING: "Pi UART has no fresh validated frames",
  EDGE_TO_RELAY_STALE: "Relay ingress is stale",
  RELAY_TO_STATION_STALE: "Station viewer is stale",
  THREE_LEGS_OBSERVED: "Packets observed at all three points",
  UPSTREAM_EVIDENCE_PARTIAL: "Upstream packet evidence is incomplete"
};
const format = (n: number | null, unit: string) => n == null ? "—" : n + " " + unit;
const label = (status: string | null) => status?.toLowerCase().replaceAll("_", " ") ?? "—";
const timestamp = (stamp: string) => new Date(stamp).toLocaleString();
const seconds = (ms: number) => (ms / 1000).toFixed(1) + " s";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Props = {
  aircraftId: string;
  telemetry?: Telemetry;
  browserTelemetry?: Telemetry | null;
  activeBrowser: boolean;
  readOnly?: boolean;
};

function receiver(telemetry: Telemetry | undefined, role: BenchRole): BenchReceiver {
  return {
    status: telemetry?.[`${role}_status`] ?? "UNKNOWN",
    transport: telemetry?.[`${role}_transport`] ?? null,
    heartbeat_fresh: telemetry?.[`${role}_heartbeat_fresh`] === true,
    attitude_fresh: telemetry?.[`${role}_attitude_fresh`] === true,
    age_ms: telemetry?.[`${role}_age_ms`] ?? null,
    frame_rate_hz: telemetry?.[`${role}_frame_rate_5s_hz`] ?? null,
    system_id: telemetry?.[`${role}_system_id`] ?? null,
    frames_total: telemetry?.[`${role}_frames_total`] ?? null,
    reconnect_attempt: telemetry?.[`${role}_reconnect_attempt`] ?? null,
    path_evidence: telemetry?.[`${role}_path_evidence`] ?? null,
    error_code: telemetry?.[`${role}_error_code`] ?? null,
  };
}

function ReceiverPath({ data }: { data: BenchReceiver }) {
  const path = data.path_evidence;
  if (!path && data.transport !== "VIHANGA_CLOUD_V2") return null;
  return <div className="bench-path">
    <p>{path ? findings[path.diagnosis] : "Waiting for broker diagnostics"}</p>
    {path && <dl>
      <div><dt>Pi UART accepted</dt><dd>{path.edge?.uart_accepted ?? "—"} · {format(path.edge?.uart_age_ms ?? null, "ms")}</dd></div>
      <div><dt>Pi uplink sent / dropped</dt><dd>{path.edge?.uplink_sent ?? "—"} / {path.edge?.uplink_dropped ?? "—"}</dd></div>
      <div><dt>Relay ingress accepted</dt><dd>{path.relay.received} · {format(path.relay.packet_age_ms, "ms")}</dd></div>
      <div><dt>Relay viewer drops</dt><dd>{path.relay.viewer_dropped}</dd></div>
      <div><dt>Station accepted</dt><dd>{data.frames_total ?? "—"} · {format(data.age_ms, "ms")}</dd></div>
    </dl>}
  </div>;
}

function ReceiverCard({ title, data, active }: { title: string; data: BenchReceiver; active?: boolean }) {
  const live = data.status === "LIVE" && data.heartbeat_fresh && data.attitude_fresh;
  return <section className="bench-receiver" aria-label={title + " receiver"}>
    <header><h3>{title}</h3><span data-live={live}>{label(data.status)}</span></header>
    <p>{data.transport ? transports[data.transport] ?? label(data.transport) :
      data.status === "UNKNOWN" ? "Awaiting station snapshot" : "No receiver"}
      {active && <b>Active viewer</b>}</p>
    <dl>
      <div><dt>Heartbeat</dt><dd>{data.heartbeat_fresh ? "Fresh" : "—"}</dd></div>
      <div><dt>Attitude</dt><dd>{data.attitude_fresh ? "Fresh" : "—"}</dd></div>
      <div><dt>Last packet</dt><dd>{format(data.age_ms, "ms")}</dd></div>
      <div><dt>Frame rate</dt><dd>{format(data.frame_rate_hz, "Hz")}</dd></div>
      <div><dt>Expected SYSID</dt><dd>{data.system_id ?? "—"}</dd></div>
      {data.status === "RECONNECTING" && Boolean(data.reconnect_attempt) &&
        <div><dt>Reconnect backoff</dt><dd>Level {data.reconnect_attempt}</dd></div>}
    </dl>
    {data.error_code && <p className="bench-error-code">{label(data.error_code)}</p>}
    <ReceiverPath data={data}/>
  </section>;
}

function saveReport(report: BenchReport) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "vihanga-bench-" + report.capture.vehicle_id + "-" + report.capture.capture_id.slice(0, 8) + ".json";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Review({ report }: { report: BenchReport }) {
  const [index, setIndex] = useState(0);
  const { samples, summary } = report;
  const sample = samples[index];
  return <div className="bench-review">
    <div className="bench-section-heading">
      <div><h3>Capture review</h3><p>{timestamp(report.capture.started_at)} · {label(report.capture.status)}</p></div>
      <button type="button" onClick={() => saveReport(report)}>Export JSON</button>
    </div>
    <div className="bench-table-wrap"><table>
      <thead><tr><th>Receiver</th><th>Live samples</th><th>Age samples</th><th>p50</th><th>p95</th><th>p99</th></tr></thead>
      <tbody>{roles.map(role => {
        const stats = summary[role];
        return <tr key={role}><th scope="row">{roleLabel[role]}</th>
          <td>{stats.configured_samples ? stats.live_samples + " / " + summary.sample_count : "Unconfigured"}</td>
          <td>{stats.age_samples}</td><td>{format(stats.p50_ms, "ms")}</td>
          <td>{format(stats.p95_ms, "ms")}</td><td>{format(stats.p99_ms, "ms")}</td></tr>;
      })}</tbody>
    </table></div>
    <p className="bench-note">Packet age at the station, measured on live samples.</p>
    {sample && <div className="bench-playback">
      <label htmlFor="bench-replay-position">Playback <strong>{seconds(sample.elapsed_ms)}</strong></label>
      <input id="bench-replay-position" type="range" min={0} max={samples.length - 1} value={index}
        disabled={samples.length < 2} aria-valuetext={seconds(sample.elapsed_ms)}
        onChange={event => setIndex(Number(event.target.value))}/>
      <div className="bench-replay-readout">
        {roles.map(role => <span key={role}><b>{roleLabel[role]}</b> {label(sample[role].status)} · {format(sample[role].age_ms, "ms")}</span>)}
        <span><b>Viewer</b> {label(sample.active_source)}</span>
      </div>
      {roles.map(role => sample[role].path_evidence && <div key={role}>
        <h4>{roleLabel[role]} path</h4><ReceiverPath data={sample[role]}/>
      </div>)}
    </div>}
    <h4>Receiver changes</h4>
    {summary.events.length ? <ol className="bench-events">
      {summary.events.map(event => <li key={event.elapsed_ms + "/" + event.field}>
        <button type="button" aria-label={"Review " + roleLabel[event.field] + " change at " + seconds(event.elapsed_ms)}
          onClick={() => setIndex(samples.findIndex(point => point.elapsed_ms === event.elapsed_ms))}>
          <time>{seconds(event.elapsed_ms)}</time><b>{roleLabel[event.field]}</b>
          <span>{label(event.from)} → {label(event.to)}</span>
        </button>
      </li>)}
    </ol> : <p className="bench-note">No receiver changes observed.</p>}
  </div>;
}

export default function Bench({ aircraftId, telemetry, browserTelemetry, activeBrowser, readOnly }: Props) {
  const [captures, setCaptures] = useState<BenchCapture[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [report, setReport] = useState<BenchReport | null>(null);
  const [duration, setDuration] = useState<BenchDuration>(60);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [listError, setListError] = useState("");
  const [reportError, setReportError] = useState("");
  const [actionError, setActionError] = useState("");
  const running = captures.find(capture => capture.status === "RECORDING");
  const selected = captures.find(capture => capture.capture_id === selectedId) ?? captures[0];
  const reportId = selected?.status === "RECORDING" ? undefined : selected?.capture_id;

  useEffect(() => {
    if (!aircraftId) return;
    let pending: AbortController | undefined;
    let gone = false;
    async function refresh() {
      if (pending) return;
      const request = new AbortController();
      pending = request;
      const timer = window.setTimeout(() => request.abort(), 4000);
      try {
        const result = await getBenchCaptures(aircraftId, request.signal);
        if (!gone) { setCaptures(result); setListError(""); }
      } catch (error) {
        if (!gone) setListError(errorText(error));
      } finally {
        window.clearTimeout(timer);
        pending = undefined;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 1800);
    return () => {
      gone = true;
      pending?.abort();
      window.clearInterval(interval);
    };
  }, [aircraftId, revision]);

  useEffect(() => {
    setReport(null);
    setReportError("");
    if (!reportId) return;
    const controller = new AbortController();
    let gone = false;
    const timer = window.setTimeout(() => controller.abort(), 4000);
    getBenchReport(aircraftId, reportId, controller.signal)
      .then(result => { if (!gone) setReport(result); })
      .catch(error => { if (!gone) setReportError(errorText(error)); })
      .finally(() => window.clearTimeout(timer));
    return () => {
      gone = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [aircraftId, reportId, revision]);

  async function toggleCapture() {
    setBusy(true);
    setActionError("");
    try {
      const capture = running
        ? (await stopBenchCapture(aircraftId, running.capture_id)).capture
        : await startBenchCapture(aircraftId, duration);
      setCaptures(current => [capture, ...current.filter(item => item.capture_id !== capture.capture_id)]);
      setSelectedId(capture.capture_id);
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setRevision(value => value + 1);
      setBusy(false);
    }
  }

  return <main className="bench-workspace" aria-labelledby="bench-title">
    <header className="bench-section-heading">
      <div><h2 id="bench-title">Bench verification</h2><p>{aircraftId || "Select an aircraft to inspect its receivers."}</p></div>
    </header>
    {aircraftId && <>
      <div className="bench-receivers">
        {roles.map(role => <ReceiverCard key={role} title={roleLabel[role]} data={receiver(telemetry, role)}
          active={!activeBrowser && telemetry?.active_source === role.toUpperCase() && Boolean(telemetry.transport)}/>)}
        {browserTelemetry && <ReceiverCard title="This PC USB" active={activeBrowser} data={{
          status: browserTelemetry.status, transport: browserTelemetry.transport,
          heartbeat_fresh: browserTelemetry.heartbeat_fresh, attitude_fresh: browserTelemetry.attitude_fresh,
          age_ms: browserTelemetry.age_ms, frame_rate_hz: browserTelemetry.frame_rate_5s_hz,
          error_code: browserTelemetry.error_code, system_id: null
        }}/>}
      </div>
      <section className="bench-captures" aria-labelledby="bench-capture-title">
        <div className="bench-section-heading">
          <div><h3 id="bench-capture-title">Station captures</h3>
            <p>Records the station API’s primary and backup receivers. This PC USB is live view only.</p></div>
          <div className="bench-record-controls">
            <select aria-label="Capture duration" value={duration} disabled={Boolean(running) || busy || readOnly}
              onChange={event => setDuration(Number(event.target.value) as BenchDuration)}>
              {benchDurations.map(value => <option key={value} value={value}>{value} s</option>)}
            </select>
            <button type="button" data-recording={Boolean(running)} disabled={busy || readOnly}
              onClick={() => void toggleCapture()}>{running ? "Stop capture" : "Start capture"}</button>
          </div>
        </div>
        {listError && <p role="status" className="bench-error">Capture list unavailable. {listError}</p>}
        {actionError && <p role="alert" className="bench-error">{actionError}</p>}
        {captures.length > 0 && <label className="bench-capture-select">Saved captures
          <select value={selected?.capture_id ?? ""} onChange={event => setSelectedId(event.target.value)}>
            {captures.map(capture => <option key={capture.capture_id} value={capture.capture_id}>
              {timestamp(capture.started_at)} · {label(capture.status)}
            </option>)}
          </select>
        </label>}
        {running && <p className="bench-note">Recording · {running.sample_count} / {running.duration_seconds} samples</p>}
        {reportError && <p className="bench-error">Capture unavailable. {reportError} <button type="button"
          onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
        {report && report.capture.capture_id === reportId && <Review key={reportId} report={report}/>}
        {!captures.length && !listError && <p className="bench-note">No captures saved for this aircraft.</p>}
      </section>
    </>}
  </main>;
}
