import { useState } from "react";
import type { Telemetry } from "./api";
import FlightTrend, { useFlightTrend } from "./FlightTrend";
import SessionRecorder from "./recorder/SessionRecorder";
import QuickView from "./flight-deck/QuickView";
import FlightEvents, { useFlightEvents } from "./FlightEvents";
import { currentTelemetry, finite, type FlightMetric, type FlightPoint } from "./flightHistory";

const ticks = [0, .125, .25, .375, .5, .625, .75, .875, 1];
const compassTicks = [-60, -45, -30, -15, 0, 15, 30, 45, 60];
const cardinal: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W" };
const bearing = (degrees: number) => (degrees % 360 + 360) % 360;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const text = (n: number | null, digits = 1) => n == null ? "—" : n.toFixed(digits);

function Gauge({ label, value, unit, min, max, detail, onTrend }: {
  label: string; value: number | null; unit: string; min: number; max: number; detail?: string; onTrend: () => void;
}) {
  const fraction = value == null ? null : clamp((value - min) / (max - min), 0, 1);
  const zero = min < 0 ? -min / (max - min) : 0;
  return <section className="station-gauge" aria-label={label}>
    <h3><button className="metric-link" type="button" onClick={onTrend} aria-label={label + " trend"}>{label}</button></h3>
    <svg viewBox="0 0 120 66" aria-hidden="true">
      <path className="gauge-track" d="M 14 59 A 46 46 0 0 1 106 59" pathLength="100"/>
      {fraction != null && <path className="gauge-fill" d="M 14 59 A 46 46 0 0 1 106 59" pathLength="100"
        strokeDasharray={Math.abs(fraction - zero) * 100 + " 100"}
        strokeDashoffset={-Math.min(fraction, zero) * 100}/>}
      {ticks.map(tick => {
        const angle = Math.PI * (1 - tick);
        const inner = tick === 0 || tick === .5 || tick === 1 ? 36 : 40;
        return <line key={tick} x1={60 + inner * Math.cos(angle)} y1={59 - inner * Math.sin(angle)}
          x2={60 + 45 * Math.cos(angle)} y2={59 - 45 * Math.sin(angle)}/>;
      })}
    </svg>
    <div className="gauge-value"><strong>{text(value)}</strong><span>{unit}</span></div>
    <div className="gauge-scale"><span>{min}</span><small>{detail || "\u00a0"}</small><span>{max}</span></div>
  </section>;
}

function Attitude({ roll, pitch }: { roll: number | null; pitch: number | null }) {
  const valid = roll != null && pitch != null;
  return <section className="station-attitude" aria-label="Artificial horizon">
    <h3>Attitude</h3>
    <div className="station-horizon" data-valid={valid}>
      {valid && <div className="station-horizon-world" style={{
        transform: `rotate(${-roll}deg) translateY(${clamp(pitch, -80, 80) * 2}px)`
      }}>
        <div className="station-horizon-line"/>
        {[-30, -20, -10, 10, 20, 30].map(mark => <span key={mark} style={{ top: `calc(50% - ${mark * 2}px)` }}>
          <b>{Math.abs(mark)}</b><i/><b>{Math.abs(mark)}</b>
        </span>)}
      </div>}
      <div className="station-reticle"><i/><b/><i/></div>
      {!valid && <span className="station-horizon-unavailable">NO DATA</span>}
    </div>
    <div className="station-attitude-values"><span>R {roll == null ? "—" : text(roll) + "°"}</span>
      <span>P {pitch == null ? "—" : text(pitch) + "°"}</span></div>
  </section>;
}

function Heading({ yaw }: { yaw: number | null }) {
  const heading = yaw == null ? null : bearing(yaw);
  const reference = heading == null ? 0 : Math.round(heading / 15) * 15;
  return <section className="station-heading" aria-label="Heading from flight controller yaw">
    <h3>Heading</h3>
    <div className="heading-tape" aria-hidden="true">
      {heading != null && compassTicks.map(offset => {
        const mark = bearing(reference + offset);
        return <span key={offset} style={{ left: 50 + (reference + offset - heading) / 1.6 + "%" }}>
          {cardinal[mark] ?? String(mark).padStart(3, "0")}
        </span>;
      })}
    </div>
    <strong>{heading == null ? "—" : String(bearing(Math.round(heading))).padStart(3, "0") + "°"}</strong>
  </section>;
}

export default function FlightInstruments({ telemetry, aircraftId = "", operator = "", onReview }: {
  telemetry?: Telemetry; aircraftId?: string; operator?: string; onReview?: (point: FlightPoint | null) => void;
}) {
  const eventLog = useFlightEvents(aircraftId, telemetry);
  return <InstrumentDisplay scope={JSON.stringify([operator, aircraftId])} onReview={onReview} key={JSON.stringify([operator, aircraftId])} aircraftId={aircraftId} telemetry={telemetry} eventLog={eventLog}/>;
}

function InstrumentDisplay({ telemetry, aircraftId, eventLog, onReview, scope }: {
  telemetry?: Telemetry; aircraftId: string; scope: string; onReview?: (point: FlightPoint | null) => void; eventLog: ReturnType<typeof useFlightEvents>;
}) {
  const [display, setDisplay] = useState<"instruments" | "trends" | "events" | "recordings">("instruments");
  const [layout, setLayout] = useState(() => {
    try { return localStorage.getItem("vihanga.flight.layout") === "quick" ? "quick" : "gauges"; }
    catch { return "gauges"; }
  });
  const [metricKey, setMetricKey] = useState<FlightMetric>();
  function showTrend(key?: FlightMetric) {
    setMetricKey(key);
    setDisplay("trends");
  }
  const data = currentTelemetry(telemetry);
  const trend = useFlightTrend(data);
  const groundspeed = finite(data?.groundspeed_mps);
  const airspeed = finite(data?.airspeed_mps);
  const altitude = finite(data?.relative_alt_m);
  const climb = finite(data?.climb_mps);
  const voltage = finite(data?.voltage_v);
  const battery = finite(data?.battery_pct);
  const climbScale = Math.max(5, Math.ceil(Math.abs(climb ?? 0) / 5) * 5);
  const roll = data?.attitude_fresh ? finite(data.roll_deg) : null;
  const pitch = data?.attitude_fresh ? finite(data.pitch_deg) : null;
  const yaw = data?.attitude_fresh ? finite(data.yaw_deg) : null;
  const heartbeat = data?.heartbeat_fresh === true;
  return <section className="station-instruments" aria-label="Flight instruments from received MAVLink">
    <div className="instrument-titlebar">
      <div role="group" aria-label="Flight display">
        <button type="button" aria-pressed={display === "instruments"} onClick={() => setDisplay("instruments")}>Instruments</button>
        <button type="button" aria-pressed={display === "trends"} onClick={() => showTrend()}>Telemetry trends</button>
        <button type="button" aria-pressed={display === "events"} onClick={() => setDisplay("events")}>Events</button>
        <button type="button" aria-pressed={display === "recordings"} onClick={() => setDisplay("recordings")}>Recorder</button>
      </div>
      {display === "instruments" && <select className="instrument-layout" aria-label="Instrument layout" value={layout}
        onChange={event => {
          const next = event.target.value;
          setLayout(next);
          try { localStorage.setItem("vihanga.flight.layout", next); } catch { /* Session-only layout. */ }
        }}>
        <option value="gauges">Gauges</option><option value="quick">Quick view</option>
      </select>}
      <span className={heartbeat ? "readout-good" : "readout-bad"} title="Flight-controller heartbeat">
        <i aria-hidden="true"/> {heartbeat ? "FC HEARTBEAT" : telemetry?.status === "STALE" ? "TELEMETRY STALE" : "NO FC HEARTBEAT"}
      </span>
    </div>
    <SessionRecorder scope={scope} aircraft={aircraftId} visible={display === "recordings"}
      latest={trend.points.at(-1)} receiver={trend.source} onReview={onReview}/>
    {display === "recordings" ? null : display === "events" ? <FlightEvents aircraftId={aircraftId} {...eventLog}/> :
      display === "trends" ? <FlightTrend key={trend.source} onReview={onReview} metricKey={metricKey} aircraftId={aircraftId} {...trend}/> :
      layout === "quick" ? <QuickView now={trend.now} points={trend.points} onTrend={showTrend}
        values={{ groundspeed_mps: groundspeed, relative_alt_m: altitude, climb_mps: climb, voltage_v: voltage }}/> :
      <div className="station-gauge-grid">
        <Gauge onTrend={() => showTrend("groundspeed_mps")} label="Ground speed" value={groundspeed} min={0} max={Math.max(30, Math.ceil((groundspeed ?? 0) / 10) * 10)} unit="m/s"
          detail={airspeed == null ? "Air —" : "Air " + text(airspeed)}/>
        <Gauge onTrend={() => showTrend("climb_mps")} label="Vertical speed" value={climb} min={-climbScale} max={climbScale} unit="m/s"/>
        <Attitude roll={roll} pitch={pitch}/>
        <Heading yaw={yaw}/>
        <div className="station-flight-readouts">
          <section><h3><button className="metric-link" type="button" onClick={() => showTrend("relative_alt_m")}>Relative altitude</button></h3><strong>{text(altitude)} <small>m</small></strong></section>
          <section><h3>GNSS</h3><strong>{data?.gps_fix_type == null ? "—" : "FIX " + data.gps_fix_type}</strong>
            <small>{data?.satellites == null ? "—" : data.satellites + " sat"}</small></section>
          <section><h3><button className="metric-link" type="button" onClick={() => showTrend("voltage_v")}>Battery</button></h3><strong>{text(voltage, 2)} <small>V</small></strong>
            <small>{battery == null ? "—" : battery + "%"}</small></section>
        </div>
      </div>}
  </section>;
}
