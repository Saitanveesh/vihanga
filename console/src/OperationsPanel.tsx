import type { Telemetry } from "./api";
import UiIcon from "./UiIcon";

type Source = "PRIMARY" | "BACKUP";
type Props = {
  aircraftId: string;
  telemetry?: Telemetry;
  busy: boolean;
  onClose: () => void;
  onConfigureBackup: () => void;
  onSelect: (source: Source) => void;
  onRemoveBackup: () => void;
};

const sensors = [
  ["gyroscope", "Gyroscope"],
  ["accelerometer", "Accelerometer"],
  ["magnetometer", "Magnetometer"],
  ["gps", "GPS sensor"],
  ["rc_receiver", "RC receiver"],
] as const;

function stateName(state: string | undefined): string {
  if (!state || state === "NOT_CONFIGURED") return "Not configured";
  return state.replaceAll("_", " ").toLowerCase();
}
function measurement(value: number | null | undefined, unit = ""): string {
  return value == null ? "—" : value.toLocaleString("en-US") + unit;
}
function sourceClass(state: string | undefined): string {
  if (state === "LIVE") return "healthy";
  if (state === "ERROR" || state === "DISCONNECTED") return "fault";
  if (state === "RECONNECTING" || state === "STALE" || state === "PARTIAL") return "caution";
  return "unknown";
}
function sensorClass(state: string): string {
  return state === "HEALTHY" ? "healthy" : state === "FAULT" ? "fault" :
    state === "DISABLED" ? "caution" : "unknown";
}

export default function OperationsPanel({
  aircraftId, telemetry, busy, onClose, onConfigureBackup, onSelect, onRemoveBackup
}: Props) {
  const source = telemetry?.active_source || "PRIMARY";
  const primary = telemetry?.primary_status || "OFFLINE";
  const backup = telemetry?.backup_status || "NOT_CONFIGURED";
  const canUseBackup = backup === "LIVE" &&
    telemetry?.backup_heartbeat_fresh && telemetry.backup_attitude_fresh;
  const canUsePrimary = primary === "LIVE" &&
    telemetry?.primary_heartbeat_fresh && telemetry.primary_attitude_fresh;
  const reported = telemetry?.sensor_health;

  return <aside className="ops-drawer" aria-label="Aircraft link and sensor diagnostics">
    <header className="ops-drawer-head">
      <div><span className="ops-eyebrow">AIRCRAFT DIAGNOSTICS</span>
        <h2>Links &amp; sensors</h2>
        <small>{aircraftId || "No aircraft selected"}</small></div>
      <button type="button" aria-label="Close diagnostics" onClick={onClose}>×</button>
    </header>

    <section className="ops-drawer-section">
      <div className="ops-drawer-heading"><UiIcon name="radio" size={17}/>
        <h3>GCS telemetry links</h3></div>
      <div className={"ops-source " + (source === "PRIMARY" ? "selected" : "")}>
        <div className="ops-source-line">
          <strong>PRIMARY {source === "PRIMARY" && <span className="ops-source-active">SELECTED</span>}</strong>
          <span className={"ops-state " + sourceClass(primary)}>{stateName(primary)}</span>
        </div>
        <small>{telemetry?.primary_transport || "No receiver connected"}</small>
      </div>
      <div className={"ops-source " + (source === "BACKUP" ? "selected" : "")}>
        <div className="ops-source-line">
          <strong>STANDBY TELEMETRY {source === "BACKUP" && <span className="ops-source-active">SELECTED</span>}</strong>
          <span className={"ops-state " + sourceClass(backup)}>{stateName(backup)}</span>
        </div>
        <small>{telemetry?.backup_transport || "No standby receiver"}</small>
        {telemetry?.backup_error_code &&
          <small className="ops-error-code">{telemetry.backup_error_code}</small>}
      </div>
      <div className="ops-switch-actions">
        <button type="button" disabled={busy || !canUseBackup || source === "BACKUP"}
          onClick={() => onSelect("BACKUP")}>Use backup</button>
        <button type="button" disabled={busy || !canUsePrimary || source === "PRIMARY"}
          onClick={() => onSelect("PRIMARY")}>Restore primary</button>
      </div>
      <button type="button" className="ops-secondary-action"
        disabled={busy || !telemetry?.primary_transport || !!telemetry?.backup_transport}
        onClick={onConfigureBackup}>Add backup telemetry link</button>
      {telemetry?.backup_transport && <button type="button" className="ops-text-action"
        disabled={busy} onClick={onRemoveBackup}>Remove backup telemetry link</button>}
      <p className="ops-note">This is a second GCS data connection, not the FlySky radio
        connected to the Pixhawk. RC pilot control remains independent.</p>
    </section>

    <section className="ops-drawer-section">
      <div className="ops-drawer-heading"><UiIcon name="radio" size={17}/>
        <h3>RC pilot receiver (Pixhawk)</h3></div>
      <div className="ops-metric-row"><span>RC input</span>
        <strong>{telemetry?.rc_input_status === "CHANNELS_REPORTED" ? "FC CHANNELS RECEIVED" :
          telemetry?.rc_input_status === "FC_HEALTHY" ? "FC REPORTS HEALTHY" :
          telemetry?.rc_input_status === "FC_FAULT" ? "FC REPORTS FAULT" :
          telemetry?.rc_input_status === "FC_DISABLED" ? "DISABLED" :
          telemetry?.rc_input_status === "FC_ABSENT" ? "NOT PRESENT" : "NOT REPORTED"}</strong></div>
      <div className="ops-metric-row"><span>Channels reported</span>
        <strong>{telemetry?.rc_channels_fresh ? measurement(telemetry.rc_channel_count) : "—"}</strong></div>
      <div className="ops-metric-row"><span>RC signal</span>
        <strong>{telemetry?.rc_rssi_raw == null ? "Not reported" : telemetry.rc_rssi_raw + " raw"}</strong></div>
      <p className="ops-note">RC_CHANNELS from the flight controller, if forwarded through MAVLink.
        An active handheld transmitter does not automatically create a GCS backup telemetry receiver.
        Missing RC data can mean that the FC is not streaming RC_CHANNELS.</p>
    </section>
    <section className="ops-drawer-section">
      <div className="ops-drawer-heading"><UiIcon name="activity" size={17}/>
        <h3>Telemetry modem &amp; data link</h3></div>
      <div className="ops-two-metrics">
        <div><small>Local RSSI</small><strong>{measurement(telemetry?.radio_rssi_raw)}</strong><span>raw 0–254</span></div>
        <div><small>Remote RSSI</small><strong>{measurement(telemetry?.radio_remote_rssi_raw)}</strong><span>raw 0–254</span></div>
        <div><small>Receive errors</small><strong>{measurement(telemetry?.radio_rx_errors)}</strong></div>
        <div><small>Fixed packets</small><strong>{measurement(telemetry?.radio_fixed_packets)}</strong></div>
      </div>
      <div className="ops-metric-row"><span>Frames received</span>
        <strong>{measurement(telemetry?.frames_total)}</strong></div>
      <div className="ops-metric-row"><span>5-second packet rate</span>
        <strong>{telemetry?.frame_rate_5s_hz == null ? "—" :
          telemetry.frame_rate_5s_hz.toFixed(1) + " Hz"}</strong></div>
      <div className="ops-metric-row"><span>Last packet age</span>
        <strong>{measurement(telemetry?.age_ms, " ms")}</strong></div>
      <p className="ops-note">RSSI is the radio's uncalibrated MAVLink value, not a
        signal percentage or dBm. “—” means the aircraft did not report it.</p>
    </section>

    <section className="ops-drawer-section">
      <div className="ops-drawer-heading"><UiIcon name="map" size={17}/>
        <h3>Satellite navigation</h3></div>
      <div className="ops-metric-row"><span>GPS 1</span>
        <strong className={telemetry?.gps_fix_type != null && telemetry.gps_fix_type >= 3 ? "ops-data-good" : ""}>
          {telemetry?.gps_fix_type == null ? "No data" : "Fix " + telemetry.gps_fix_type}
        </strong></div>
      <div className="ops-metric-row"><span>GPS 1 satellites</span>
        <strong>{measurement(telemetry?.satellites)}</strong></div>
      <div className="ops-metric-row"><span>GPS 2</span>
        <strong>{telemetry?.gps2_fix_type == null ? "No data" : "Fix " + telemetry.gps2_fix_type}</strong></div>
      <div className="ops-metric-row"><span>GPS 2 satellites</span>
        <strong>{measurement(telemetry?.gps2_satellites)}</strong></div>
    </section>

    <section className="ops-drawer-section">
      <div className="ops-drawer-heading"><UiIcon name="shield" size={17}/>
        <h3>Onboard sensors</h3></div>
      <div className="ops-sensor-list">
        {sensors.map(([key, label]) => {
          const state = reported?.[key] ?? "NOT_REPORTED";
          return <div className="ops-sensor" key={key}>
            <span>{label}</span>
            <strong className={"ops-state " + sensorClass(state)}>
              {state.replace("_", " ").toLowerCase()}</strong>
          </div>;
        })}
      </div>
      <p className="ops-note">Read from SYS_STATUS presence, enabled and health flags.
        No status is assumed if the message is absent.</p>
    </section>
    <footer className="ops-drawer-foot">Receive-only telemetry · No command authority</footer>
  </aside>;
}
