import type { Telemetry } from "./api";

type Props = { telemetry?: Telemetry };

const fixed = (n: number | null | undefined, digits=1) => n == null ? "—" : n.toFixed(digits);

/** Instruments remain neutral when genuine ATTITUDE/GPS packets are stale. */
export default function FlightInstruments({ telemetry }: Props) {
  const attitudeOk = telemetry?.attitude_fresh === true &&
    telemetry.roll_deg != null && telemetry.pitch_deg != null;
  const roll = attitudeOk ? telemetry!.roll_deg! : 0;
  const pitch = attitudeOk ? telemetry!.pitch_deg! : 0;
  const yaw = telemetry?.yaw_deg;
  const heading = telemetry?.attitude_fresh && yaw != null ? (yaw + 360) % 360 : null;
  return <section className="instrument-dock" aria-label="Flight instruments from received MAVLink">
    <div className="dock-readouts dock-left">
      <div><small>ALTITUDE / RELATIVE</small><strong>{fixed(telemetry?.relative_alt_m,2)} <span>m</span></strong></div>
      <div><small>GROUND SPEED</small><strong>{fixed(telemetry?.groundspeed_mps,2)} <span>m/s</span></strong></div>
      <div><small>CLIMB RATE</small><strong>{fixed(telemetry?.climb_mps,2)} <span>m/s</span></strong></div>
    </div>
    <div className="primary-instruments">
      <div className="pfd-group">
        <div className={"attitude-face " + (!attitudeOk ? "invalid" : "")}
          title={attitudeOk ? "Live attitude: roll " + roll.toFixed(1) + "°, pitch " + pitch.toFixed(1) + "°" : "No fresh attitude frames"}>
          {attitudeOk && <div className="attitude-rotator" style={{transform:
            "rotate(" + (-roll) + "deg) translateY(" + (Math.max(-75,Math.min(75,pitch))*1.6) + "px)"}}>
            <div className="sky"/>
            <div className="ground"/>
            <div className="horizon-bar"/>
            <div className="pitch-mark upper-mark">+10</div>
            <div className="pitch-mark lower-mark">−10</div>
          </div>}
          <div className="aircraft-reticle"><span/><b/><span/></div>
          {!attitudeOk && <div className="no-attitude">NO DATA</div>}
        </div>
        <div className="instrument-name">ATTITUDE</div>
      </div>
      <div className="pfd-group">
        <div className={"compass-face " + (heading == null ? "invalid" : "")} title={heading == null ? "Heading unavailable" : "Heading " + heading.toFixed(0) + "°"}>
          {heading != null && <>
            <div className="compass-card" style={{transform:"rotate(" + (-heading) + "deg)"}}>
              <span className="c-n">N</span><span className="c-e">E</span>
              <span className="c-s">S</span><span className="c-w">W</span>
              <span className="c-diag d1"/><span className="c-diag d2"/>
            </div>
            <div className="compass-pointer"/>
          </>}
          <div className="compass-number">{heading == null ? "—" : heading.toFixed(0).padStart(3,"0") + "°"}</div>
        </div>
        <div className="instrument-name">HEADING</div>
      </div>
    </div>
    <div className="dock-readouts dock-right">
      <div><small>BATTERY VOLTAGE</small><strong>{fixed(telemetry?.voltage_v,2)} <span>V</span></strong></div>
      <div><small>GPS / SATELLITES</small><strong>{telemetry?.gps_fix_type == null ? "—" : "FIX " + telemetry.gps_fix_type} <span>{telemetry?.satellites == null ? "" : " / " + telemetry.satellites}</span></strong></div>
      <div><small>FC HEARTBEAT</small><strong className={telemetry?.heartbeat_fresh ? "readout-good" : "readout-bad"}>{telemetry?.heartbeat_fresh ? "FRESH" : "NO DATA"}</strong></div>
    </div>
  </section>;
}
