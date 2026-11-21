import { useEffect, useRef, useState } from "react";
import type { Telemetry } from "./api";
import UiIcon from "./UiIcon";

export type Condition = "OK" | "WARN" | "DOWN" | "UNKNOWN";

export interface LinkAssessment {
  condition: Condition;
  headline: string;
  explanation: string;
}

export function assessAircraft(sample?: Telemetry, aircraftId = ""): LinkAssessment {
  if (!aircraftId) return { condition: "UNKNOWN", headline: "NO AIRCRAFT", explanation: "Select an aircraft to observe its telemetry." };
  if (!sample || sample.status === "OFFLINE" || sample.status === "DISCONNECTED" ||
      sample.status === "ERROR") {
    return { condition: "DOWN", headline: "OFFLINE", explanation: "No active receiver for this aircraft." };
  }
  if (sample.status === "RECONNECTING" || sample.status === "CONNECTING") {
    return { condition: "WARN", headline: "RECONNECTING", explanation: "Awaiting the next authenticated telemetry session." };
  }
  if (!sample.heartbeat_fresh || !sample.attitude_fresh || sample.status !== "LIVE") {
    return { condition: "WARN", headline: "STALE DATA", explanation: "Fresh FC heartbeat and attitude are not both available." };
  }
  if (sample.age_ms != null && sample.age_ms > 2000) {
    return { condition: "WARN", headline: "DELAYED", explanation: "Latest recorded telemetry packet is older than two seconds." };
  }
  return { condition: "OK", headline: "RECEIVING", explanation: "FC heartbeat and attitude are fresh on the selected receiver." };
}

export function assessGcs(lastProbe: number | null, failed: boolean): LinkAssessment {
  if (failed) return { condition: "DOWN", headline: "API OFFLINE", explanation: "Browser cannot reach the Vihanga operations API." };
  if (lastProbe == null) return { condition: "UNKNOWN", headline: "CHECKING", explanation: "Measuring the browser-to-API request time." };
  if (lastProbe > 1000) return { condition: "WARN", headline: "SLOW RESPONSE", explanation: "Browser-to-API request exceeded one second." };
  return { condition: "OK", headline: "API REACHABLE", explanation: "Browser-to-API request completed successfully." };
}

interface EventEntry { id: number; when: string; text: string; condition: Condition }
interface Props {
  aircraftId: string;
  telemetry?: Telemetry;
  viewerConnected: boolean;
}

function formatMs(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : Math.round(value) + " ms";
}

export default function NetworkWatch({ aircraftId, telemetry, viewerConnected }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [rtt, setRtt] = useState<number | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [history, setHistory] = useState<number[]>([]);
  const eventSequence = useRef(0);
  const previousGcs = useRef<Condition | null>(null);
  const previousAircraft = useRef<Condition | null>(null);
  const previousId = useRef("");

  const aircraft = assessAircraft(telemetry, aircraftId);
  const gcs = assessGcs(rtt, probeFailed);
  const stamp = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Measure actual HTTP request time to the local GCS service. This is not
  // Wi-Fi radio RSSI, ISP speed, internet latency, or end-to-end FC command RTT.
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    async function probe() {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      const deadline = window.setTimeout(() => controller.abort(), 4000);
      const start = performance.now();
      try {
        const response = await fetch("/api/v1/health", {
          signal: controller.signal,
          cache: "no-store",
          headers: { Accept: "application/json" }
        });
        if (!response.ok) throw new Error("API response failed");
        const body: unknown = await response.json();
        if (!body || typeof body !== "object" ||
          (body as { status?: string }).status !== "ok") throw new Error("Invalid health response");
        const elapsed = Math.max(0, Math.round(performance.now() - start));
        if (!cancelled) {
          setRtt(elapsed);
          setProbeFailed(false);
          setHistory(previous => [...previous.slice(-19), elapsed]);
          setLastChecked(stamp());
        }
      } catch {
        if (!cancelled) {
          setProbeFailed(true);
          setRtt(null);
          setLastChecked(stamp());
        }
      } finally {
        window.clearTimeout(deadline);
        inFlight = false;
      }
    }
    void probe();
    const interval = window.setInterval(() => void probe(), 5000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  // Record genuine state transitions only. Starting with an unconnected FC
  // isn't an outage; we alert only after a previously healthy live link drops.
  useEffect(() => {
    if (gcs.condition === "UNKNOWN") return;
    if (previousGcs.current != null && previousGcs.current !== gcs.condition &&
        (gcs.condition !== "OK" || previousGcs.current !== "UNKNOWN")) {
      const text = gcs.condition === "DOWN" ? "GCS API connection lost" :
        gcs.condition === "WARN" ? "GCS API response delayed" : "GCS API connection restored";
      const id = ++eventSequence.current;
      setEvents(old => [{ id, when: stamp(), text, condition: gcs.condition }, ...old].slice(0, 12));
    }
    previousGcs.current = gcs.condition;
  }, [gcs.condition]);

  useEffect(() => {
    if (previousId.current !== aircraftId) {
      previousId.current = aircraftId;
      previousAircraft.current = aircraft.condition;
      return;
    }
    const prev = previousAircraft.current;
    if (prev && prev !== aircraft.condition && (prev === "OK" || aircraft.condition === "OK")) {
      const text = aircraft.condition === "OK" ? "Aircraft telemetry restored" :
        "Aircraft telemetry degraded: " + aircraft.headline.toLowerCase();
      const id = ++eventSequence.current;
      setEvents(old => [{ id, when: stamp(), text, condition: aircraft.condition }, ...old].slice(0, 12));
    }
    previousAircraft.current = aircraft.condition;
  }, [aircraftId, aircraft.condition, aircraft.headline]);

  const alertCount = events.filter(event => event.condition === "DOWN" || event.condition === "WARN").length;
  const peak = Math.max(120, ...history);
  const hasRadio = telemetry?.status === "LIVE" &&
    telemetry.radio_rssi_raw != null && Number.isFinite(telemetry.radio_rssi_raw);
  const recentTrend = history.length >= 3 ?
    Math.round(history.slice(-3).reduce((sum, value) => sum + value, 0) / 3) : null;

  return <aside className={"network-watch" + (expanded ? " expanded" : "")}
    aria-label="GCS and aircraft network monitor">
    <button className="network-watch-top" type="button"
      onClick={() => setExpanded(value => !value)}
      aria-expanded={expanded} aria-controls="network-watch-details">
      <span className="network-watch-name"><UiIcon name="radio" size={14}/>
        LINK MONITOR</span>
      <span className={"network-watch-indicator " + gcs.condition.toLowerCase()}>
        GCS {rtt == null ? (probeFailed ? "OFFLINE" : "CHECKING") : formatMs(rtt)}</span>
      <span className={"network-watch-indicator " + aircraft.condition.toLowerCase()}>
        UAV {aircraft.headline}</span>
      {alertCount > 0 && <span className="network-watch-alert-count" title="Recent link warnings">
        {alertCount}</span>}
      <span className="network-watch-caret">{expanded ? "−" : "+"}</span>
    </button>
    {expanded && <div id="network-watch-details" className="network-watch-details">
      <section className="network-watch-block">
        <div><strong>GROUND CONSOLE</strong><small className={gcs.condition.toLowerCase()}>{gcs.headline}</small></div>
        <dl>
          <div><dt>Browser → API</dt><dd>{formatMs(rtt)}</dd></div>
          <div><dt>Average, last 3</dt><dd>{formatMs(recentTrend)}</dd></div>
          <div><dt>Telemetry viewer</dt><dd>{viewerConnected ? "WebSocket connected" : "Not connected"}</dd></div>
          <div><dt>Last API check</dt><dd>{lastChecked ?? "—"}</dd></div>
        </dl>
        {history.length > 1 && <div className="network-watch-trend" role="img"
          aria-label={"Recent browser to API request times: " + history.join(", ") + " milliseconds"}>
          {history.map((point, index) => <span key={index}
            style={{height: Math.max(3, Math.round(27 * point / peak)) + "px"}}
            className={point > 1000 ? "slow" : ""}/>)}
        </div>}
      </section>
      <section className="network-watch-block">
        <div><strong>AIRCRAFT LINK</strong><small className={aircraft.condition.toLowerCase()}>{aircraft.headline}</small></div>
        <dl>
          <div><dt>Selected receiver</dt><dd>{telemetry?.active_source ?? "—"}</dd></div>
          <div><dt>Last MAVLink packet</dt><dd>{formatMs(telemetry?.age_ms)}</dd></div>
          <div><dt>Received packet rate</dt><dd>{telemetry?.status === "LIVE"
            ? telemetry.frame_rate_5s_hz.toFixed(1) + " Hz" : "—"}</dd></div>
          <div><dt>RC pilot input</dt><dd>{telemetry?.rc_input_status === "CHANNELS_REPORTED"
            ? "Channels observed" : telemetry?.rc_input_status === "FC_HEALTHY"
            ? "FC reports healthy" : telemetry?.rc_input_status === "FC_FAULT"
            ? "FC reports fault" : telemetry?.rc_input_status === "FC_DISABLED"
            ? "Disabled" : telemetry?.rc_input_status === "FC_ABSENT"
            ? "Absent" : "Not reported"}</dd></div>
          <div><dt>RC channels</dt><dd>{telemetry?.rc_channels_fresh
            ? telemetry.rc_channel_count : "—"}</dd></div>
          <div><dt>RC RSSI</dt><dd>{telemetry?.rc_rssi_raw != null
            ? telemetry.rc_rssi_raw + " raw" : "Not reported"}</dd></div>
          <div><dt>Local radio RSSI</dt><dd>{hasRadio ? telemetry?.radio_rssi_raw + " raw" : "Not reported"}</dd></div>
          <div><dt>Remote radio RSSI</dt><dd>{telemetry?.status === "LIVE" &&
            telemetry?.radio_remote_rssi_raw != null ?
            telemetry.radio_remote_rssi_raw + " raw" : "Not reported"}</dd></div>
          <div><dt>Radio receive errors</dt><dd>{telemetry?.status === "LIVE" &&
            telemetry.radio_rx_errors != null ? telemetry.radio_rx_errors : "—"}</dd></div>
          <div><dt>Backup receiver</dt><dd>{telemetry?.backup_status ?? "Not configured"}</dd></div>
        </dl>
        <p>{aircraft.explanation}</p>
      </section>
      {events.length > 0 && <section className="network-watch-events">
        <div className="network-watch-events-head"><strong>EVENTS</strong>
          <button type="button" onClick={() => setEvents([])}>Clear</button></div>
        <ul>{events.slice(0, 6).map(event =>
          <li key={event.id} className={event.condition.toLowerCase()}>
            <time>{event.when}</time>{event.text}</li>)}</ul>
      </section>}
      <p className="network-watch-disclaimer">
        GCS time is measured browser-to-API response, not Wi-Fi strength.
        MAVLink RC_CHANNELS and RADIO_STATUS are separate raw reports, not dBm or calibrated strength percentages.
      </p>
    </div>}
    <div className="network-watch-sr-status" role="status" aria-live="polite">
      {gcs.condition === "DOWN" ? "GCS operations API offline" :
        aircraftId && aircraft.condition === "WARN" ? "Aircraft telemetry requires attention" :
        aircraftId && aircraft.condition === "DOWN" ? "Aircraft telemetry offline" : ""}
    </div>
  </aside>;
}
