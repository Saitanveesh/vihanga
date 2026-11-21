import { useEffect, useRef, useState } from "react";
import type { Telemetry } from "./api";
import { currentTelemetry, downloadCsv } from "./flightHistory";

type Category = "Link" | "Aircraft" | "Marker";
type FlightEvent = { id: number; at: number; category: Category; message: string };
type Observation = {
  status: string;
  source?: string;
  mode?: string;
  armed?: boolean;
  gpsFix?: number;
  rcFailsafe?: boolean;
};
const MAX_EVENTS = 200;
const EMPTY_EVENTS: FlightEvent[] = [];
const linkEvents: Record<string, string> = {
  LIVE: "Telemetry live", PARTIAL: "Partial telemetry", STALE: "Telemetry stale",
  CONNECTING: "Connecting", RECONNECTING: "Reconnecting", WAITING_FOR_FRAMES: "Waiting for MAVLink",
  ERROR: "Telemetry link error", OFFLINE: "Telemetry offline", NO_DATA: "Telemetry unavailable"
};
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});

function csvCell(body: string) {
  const safe = /^[=+\-@\s]/.test(body) ? "'" + body : body;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function eventCsv(aircraftId: string, events: FlightEvent[]) {
  const rows = [...events].reverse().map(event =>
    [new Date(event.at).toISOString(), aircraftId, event.category, event.message].map(csvCell).join(",")
  );
  return ["observed_utc,aircraft_id,category,event", ...rows].join("\r\n");
}

function prependEvents(archive: Map<string, FlightEvent[]>, aircraftId: string, events: FlightEvent[]) {
  const result = new Map(archive);
  result.set(aircraftId, [...events, ...archive.get(aircraftId) ?? EMPTY_EVENTS].slice(0, MAX_EVENTS));
  return result;
}

export function useFlightEvents(aircraftId: string, telemetry?: Telemetry) {
  const [events, setEvents] = useState(() => new Map<string, FlightEvent[]>());
  const previous = useRef(new Map<string, Observation>());
  const sequence = useRef(0);
  const current = currentTelemetry(telemetry);
  const status = telemetry?.status ?? "NO_DATA";
  const source = current?.transport
    ? (current.active_source ?? "PRIMARY") + " · " + current.transport.replaceAll("_", " ") : undefined;
  const mode = current?.heartbeat_fresh ? current.mode ?? undefined : undefined;
  const armed = current?.heartbeat_fresh ? current.armed ?? undefined : undefined;
  const gpsFix = current?.gps_fix_type ?? undefined;
  const rcFailsafe = current?.rc_failsafe_reported ?? undefined;

  useEffect(() => {
    if (!aircraftId) return;
    const before = previous.current.get(aircraftId);
    const observed: FlightEvent[] = [];
    const at = Date.now();
    const add = (category: Category, message: string) =>
      observed.push({ id: ++sequence.current, at, category, message });
    if (status !== before?.status) add("Link", linkEvents[status] ?? "Telemetry state unknown");
    if (source !== undefined && source !== before?.source) add("Link", "Source: " + source);
    if (mode !== undefined && mode !== before?.mode) add("Aircraft", "Mode: " + mode);
    if (armed !== undefined && armed !== before?.armed) add("Aircraft", armed ? "FC reports armed" : "FC reports disarmed");
    if (gpsFix !== undefined && gpsFix !== before?.gpsFix) add("Aircraft", "GNSS fix: " + gpsFix);
    if (rcFailsafe === true && before?.rcFailsafe !== true) add("Aircraft", "FC reports RC failsafe");
    if (rcFailsafe === false && before?.rcFailsafe === true) add("Aircraft", "FC reports RC failsafe cleared");
    previous.current.set(aircraftId, {
      status, source: source ?? before?.source, mode: mode ?? before?.mode, armed: armed ?? before?.armed,
      gpsFix: gpsFix ?? before?.gpsFix, rcFailsafe: rcFailsafe ?? before?.rcFailsafe
    });
    if (observed.length) {
      observed.reverse();
      setEvents(byAircraft => prependEvents(byAircraft, aircraftId, observed));
    }
  }, [aircraftId, status, source, mode, armed, gpsFix, rcFailsafe]);

  function mark() {
    if (!aircraftId) return;
    const marker: FlightEvent = { id: ++sequence.current, at: Date.now(), category: "Marker", message: "Operator marker" };
    setEvents(byAircraft => prependEvents(byAircraft, aircraftId, [marker]));
  }

  return { events: events.get(aircraftId) ?? EMPTY_EVENTS, mark };
}

export default function FlightEvents({ aircraftId, events, mark }: {
  aircraftId: string; events: FlightEvent[]; mark: () => void;
}) {
  return <div className="station-events">
    <div className="station-events-tools">
      <span>{aircraftId ? "Recorded while selected · Local time" : "Select an aircraft to start the event log"}</span>
      <div>
        <button type="button" disabled={!aircraftId} onClick={mark}>Add marker</button>
        <button type="button" disabled={!events.length} onClick={() =>
          downloadCsv(eventCsv(aircraftId, events), "vihanga-" + aircraftId + "-events.csv")}>Export events</button>
      </div>
    </div>
    <ol className="station-events-list" aria-label="Flight event log" tabIndex={events.length ? 0 : undefined}>
      {events.map(event => <li key={event.id}>
        <time dateTime={new Date(event.at).toISOString()}>{timeFormat.format(event.at)}</time>
        <span className="station-event-kind" data-category={event.category}>{event.category}</span>
        <strong>{event.message}</strong>
      </li>)}
    </ol>
  </div>;
}
