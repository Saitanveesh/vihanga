import { useState } from "react";
import type { Telemetry } from "./api";
import UiIcon from "./UiIcon";

type Props = {
  telemetry?: Telemetry;
  vehicleId: string;
  cameraUrl: string;
  onOpenVideo: () => void;
};
const measurement = (n: number | null | undefined, digits: number, unit: string) =>
  n == null ? "—" : n.toFixed(digits) + " " + unit;

export default function SystemsPanel({ telemetry, vehicleId, cameraUrl, onOpenVideo }: Props) {
  const [preview, setPreview] = useState(false);
  const online = telemetry?.status === "LIVE";
  return <aside className="systems-panel" aria-label="Aircraft systems">
    <header className="systems-head">
      <div><span className="systems-eyebrow">TELEMETRY · {vehicleId || "NO AIRCRAFT"}</span>
        <h2>Aircraft systems</h2></div>
      <span className={"systems-led " + (online ? "up" : "")}
        title={online ? "Fresh heartbeat and attitude" : "Live telemetry unavailable"}/>
    </header>
    <div className="systems-metrics">
      <div><span>Power</span>
        <strong>{measurement(telemetry?.voltage_v, 2, "V")}</strong>
        <small>{telemetry?.battery_current_a == null ? "Current unavailable"
          : measurement(telemetry.battery_current_a, 2, "A") + " drawn"}</small></div>
      <div><span>Primary GNSS</span>
        <strong>{telemetry?.gps_fix_type == null ? "No data" : "Fix " + telemetry.gps_fix_type}</strong>
        <small>{telemetry?.satellites == null ? "Satellites unavailable" : telemetry.satellites + " satellites"}</small></div>
      <div><span>Secondary GNSS</span>
        <strong>{telemetry?.gps2_fix_type == null ? "No data" : "Fix " + telemetry.gps2_fix_type}</strong>
        <small>{telemetry?.gps2_satellites == null ? "Not reported"
          : telemetry.gps2_satellites + " satellites"}</small></div>
      <div><span>Air speed</span>
        <strong>{measurement(telemetry?.airspeed_mps, 1, "m/s")}</strong>
        <small>{telemetry?.throttle_pct == null ? "Throttle unavailable"
          : "Throttle " + telemetry.throttle_pct + "%"}</small></div>
    </div>
    <div className="systems-health"><UiIcon name="activity" size={16}/>
      <span>{online ? "Live MAVLink" : telemetry?.status || "Offline"}</span>
      <strong>{telemetry ? telemetry.frame_rate_5s_hz.toFixed(1) + " Hz" : "—"}</strong>
    </div>
    <section className="systems-video">
      <header><span><UiIcon name="video" size={16}/> Camera</span>
        {cameraUrl && <button type="button" onClick={() => setPreview(value => !value)}>
          {preview ? "Hide" : "Preview"}
        </button>}
      </header>
      {cameraUrl && preview ? <iframe title="Compact aircraft camera" src={cameraUrl}
        referrerPolicy="no-referrer" allow="autoplay; fullscreen" allowFullScreen/> :
        <p>{cameraUrl ? "Preview on demand to limit camera bandwidth." :
          "No camera configured for this aircraft."}</p>}
      <button type="button" className="systems-open-video" onClick={onOpenVideo}>
        {cameraUrl ? "Open video workspace" : "Configure camera"} <span aria-hidden="true">↗</span>
      </button>
    </section>
  </aside>;
}
