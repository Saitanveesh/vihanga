import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Telemetry } from "./api";
import UiIcon from "./UiIcon";

export type ConnectionMethod = "SERIAL" | "UDP" | "TCP" | "LAN" | "BROKER" | "CLOUD";
export type ConnectionRole = "PRIMARY" | "BACKUP";

export interface ConnectionRequest {
  role: ConnectionRole;
  method: ConnectionMethod;
  origin: string;
  username: string;
  password: string;
  viewerToken: string;
  serialPort: string;
  baud: number;
  port: number;
  systemId: number;
}

interface Props {
  aircraftName: string;
  aircraftId: string;
  telemetry?: Telemetry;
  initialRole: ConnectionRole;
  busy: boolean;
  error: string;
  onConnect: (request: ConnectionRequest) => Promise<void>;
  onActivate: (role: ConnectionRole) => Promise<void>;
  onRemoveBackup: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onClose: () => void;
}

const methods: { id: ConnectionMethod; label: string; description: string;
  icon: "link" | "activity" | "database" | "radio" | "shield" }[] = [
  { id: "SERIAL", label: "Serial / USB", description: "Direct FC", icon: "link" },
  { id: "UDP", label: "UDP", description: "Local listener", icon: "activity" },
  { id: "TCP", label: "TCP", description: "Local client", icon: "database" },
  { id: "LAN", label: "Direct Wi-Fi", description: "Private Pi LAN", icon: "radio" },
  { id: "BROKER", label: "Vihanga Cloud", description: "Cloud broker", icon: "radio" },
  { id: "CLOUD", label: "Private relay", description: "Operator relay", icon: "shield" },
];

function storedOrigin(method: ConnectionMethod): string {
  if (!["LAN", "BROKER", "CLOUD"].includes(method)) return "";
  try { return localStorage.getItem("vihanga.receiver.origin." + method.toLowerCase() + ".v1") || ""; }
  catch { return ""; }
}

function knownCloudUser() {
  try { return localStorage.getItem("vihanga.receiver.user.cloud.v1") || ""; }
  catch { return ""; }
}

const isValidSerial = (value: string): boolean =>
  /^(COM[1-9][0-9]{0,2}|\/dev\/tty(?:USB|ACM)[0-9]{1,2})$/.test(value.trim());

export function validateConnection(input: ConnectionRequest): string | null {
  if (!input.systemId || !Number.isInteger(input.systemId) ||
      input.systemId < 1 || input.systemId > 254) {
    return "MAVLink system ID must be an integer between 1 and 254.";
  }
  if (input.method === "SERIAL") {
    if (!isValidSerial(input.serialPort)) return "Use a valid serial port such as COM3 or /dev/ttyUSB0.";
    if (![9600,19200,38400,57600,115200,230400,460800,921600].includes(input.baud)) {
      return "Select a supported serial baud rate.";
    }
  }
  if (input.method === "UDP" || input.method === "TCP") {
    if (!Number.isInteger(input.port) || input.port < 1024 || input.port > 65535) {
      return "Local port must be between 1024 and 65535.";
    }
  }
  if (["LAN", "BROKER", "CLOUD"].includes(input.method)) {
    let url: URL;
    try { url = new URL(input.origin); }
    catch { return "Enter a valid HTTPS connection address."; }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) {
      return "Use an HTTPS origin without a path, query, or embedded credentials.";
    }
    if (input.method === "LAN" &&
        !/^https:\/\/(10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):(?:876[5-9]|877[0-5])$/.test(input.origin.trim())) {
      // The backend remains the final authority for RFC1918 and approved port validation.
      // This client hint is intentionally conservative and descriptive.
      return "Use the Pi's private IPv4 HTTPS address and its configured port (8765–8775).";
    }
  }
  if ((input.method === "LAN" || input.method === "BROKER") &&
      input.viewerToken.length < 32) return "Viewer token must contain at least 32 characters.";
  if (input.method === "CLOUD" && (!input.username.trim() || !input.password)) {
    return "Private relay username and password are required.";
  }
  return null;
}

export default function ConnectionSettings({
  aircraftName, aircraftId, telemetry, initialRole, busy, error,
  onConnect, onActivate, onRemoveBackup, onDisconnect, onClose
}: Props) {
  const [role, setRole] = useState<ConnectionRole>(initialRole);
  const [method, setMethod] = useState<ConnectionMethod>(
    initialRole === "BACKUP" ? "LAN" : "CLOUD"
  );
  const [origin, setOrigin] = useState(
    () => storedOrigin(initialRole === "BACKUP" ? "LAN" : "CLOUD")
  );
  const [username, setUsername] = useState(knownCloudUser);
  const [password, setPassword] = useState("");
  const [viewerToken, setViewerToken] = useState("");
  const [serialPort, setSerialPort] = useState("COM3");
  const [baud, setBaud] = useState(57600);
  const [port, setPort] = useState(14550);
  const [systemId, setSystemId] = useState(1);
  const [localError, setLocalError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { closeRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !busy) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function chooseMethod(next: ConnectionMethod) {
    setMethod(next);
    setOrigin(storedOrigin(next));
    setViewerToken("");
    setPassword("");
    setLocalError("");
    if (next === "TCP") setPort(5760);
    if (next === "UDP") setPort(14550);
  }

  const selectedPrimary = telemetry?.active_source !== "BACKUP";
  const primaryExists = Boolean(telemetry?.primary_transport);
  const backupExists = Boolean(telemetry?.backup_transport);
  const alreadyConfigured = role === "PRIMARY" ? primaryExists : backupExists;
  const cannotAddBackup = role === "BACKUP" && !primaryExists;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!aircraftId || busy || alreadyConfigured || cannotAddBackup) return;
    const request: ConnectionRequest = {
      role, method, origin: origin.trim(), username: username.trim(),
      password, viewerToken, serialPort: serialPort.trim(), baud, port, systemId
    };
    const validationError = validateConnection(request);
    if (validationError) { setLocalError(validationError); return; }
    setLocalError("");
    await onConnect(request);
  }

  function receiverStatus(kind: "PRIMARY" | "BACKUP") {
    const status = kind === "PRIMARY" ? telemetry?.primary_status : telemetry?.backup_status;
    const transport = kind === "PRIMARY" ? telemetry?.primary_transport : telemetry?.backup_transport;
    const selected = kind === "PRIMARY" ? selectedPrimary : !selectedPrimary;
    return <div className={"connection-link-card " + (status === "LIVE" ? "live " : "") +
      (selected ? "is-selected" : "")}>
      <div className="connection-link-title">
        <span className={"connection-status-dot " + (status === "LIVE" ? "live" : "")}/>
        <strong>{kind === "PRIMARY" ? "Primary link" : "Backup link"}</strong>
        {selected && <span className="connection-selected">Selected</span>}
      </div>
      <span className="connection-link-status">{status?.replaceAll("_", " ") ||
        (kind === "PRIMARY" ? "NOT CONNECTED" : "NOT CONFIGURED")}</span>
      <small>{transport?.replaceAll("_", " ") ||
        (kind === "PRIMARY" ? "Select a connection type" : "Standby path not configured")}</small>
    </div>;
  }

  return <div className="modal-backdrop connection-settings-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section className="connect-dialog connection-settings-panel" role="dialog"
      aria-modal="true" aria-labelledby="connect-title"
      aria-describedby="connection-description">
      <header className="connection-settings-head">
        <div>
          <span className="connection-kicker">VIHANGA / COMMUNICATIONS</span>
          <h2 id="connect-title">Connection settings</h2>
          <p id="connection-description">{aircraftName || "Aircraft"} · {aircraftId || "No aircraft selected"}</p>
        </div>
        <button ref={closeRef} type="button" onClick={onClose}
          className="connection-settings-close" disabled={busy} aria-label="Close connection settings">×</button>
      </header>

      <div className="connection-settings-scroll">
        <div className="connection-status-grid" aria-label="Live receiver status">
          {receiverStatus("PRIMARY")}
          {receiverStatus("BACKUP")}
        </div>

        <div className="connection-settings-section">
          <span className="connection-settings-label">CONFIGURE RECEIVER</span>
          <div className="connection-role-switch" role="group" aria-label="Receiver assignment">
            {(["PRIMARY", "BACKUP"] as const).map(item =>
              <button type="button" key={item} onClick={() => {
                setRole(item); setLocalError("");
              }} aria-pressed={role === item} className={role === item ? "active" : ""}>
                {item === "PRIMARY" ? "Primary" : "Backup"}
                {item === "BACKUP" && <small>Standby</small>}
              </button>
            )}
          </div>
        </div>

        <div className="connection-settings-section">
          <span className="connection-settings-label">CONNECTION TYPE</span>
          <div className="connection-settings-methods" role="group" aria-label="Connection method">
            {methods.map(item => <button key={item.id} type="button"
              aria-pressed={method === item.id}
              className={method === item.id ? "active" : ""}
              onClick={() => chooseMethod(item.id)}>
              <UiIcon name={item.icon} size={18}/>
              <span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>)}
          </div>
        </div>

        <form id="connection-settings-form" onSubmit={event => { void submit(event); }}
          className="connection-settings-form">
          <div className="connection-settings-section">
            <span className="connection-settings-label">CONNECTION DETAILS</span>
            {method === "SERIAL" && <div className="connection-settings-field-grid">
              <label>Serial port<input required value={serialPort}
                placeholder="COM3" autoComplete="off"
                onChange={event => setSerialPort(event.target.value)}/></label>
              <label>Baud rate<select value={baud}
                onChange={event => setBaud(Number(event.target.value))}>
                {[9600,19200,38400,57600,115200,230400,460800,921600].map(value =>
                  <option value={value} key={value}>{value}</option>)}
              </select></label>
            </div>}
            {(method === "UDP" || method === "TCP") && <div className="connection-settings-field-grid">
              <label>IP address<input readOnly value="127.0.0.1"
                title="Local-only receiver; non-loopback addresses are not accepted"/></label>
              <label>{method === "TCP" ? "TCP port" : "UDP listen port"}
                <input required type="number" min={1024} max={65535} value={port}
                  onChange={event => setPort(Number(event.target.value))}/></label>
            </div>}
            {(method === "BROKER" || method === "CLOUD" || method === "LAN") && <>
              <label>{method === "LAN" ? "Raspberry Pi LAN address" :
                method === "BROKER" ? "Vihanga Cloud origin" : "Private relay origin"}
                <input required type="url" value={origin}
                  placeholder={method === "LAN" ? "https://192.168.1.50:8765" : "https://host.ts.net:8443"}
                  autoComplete="url" onChange={event => setOrigin(event.target.value)}/>
              </label>
              {method === "CLOUD" ? <div className="connection-settings-field-grid">
                <label>Operator username<input required value={username} autoComplete="username"
                  onChange={event => setUsername(event.target.value)}/></label>
                <label>Operator password<input type="password" required value={password}
                  autoComplete="off" onChange={event => setPassword(event.target.value)}/></label>
              </div> : <label>Aircraft viewer token<input type="password" required
                value={viewerToken} minLength={32} autoComplete="off"
                placeholder="Enter aircraft-scoped token"
                onChange={event => setViewerToken(event.target.value)}/></label>}
            </>}
            <label>FC MAVLink system ID<input type="number" required min={1} max={254}
              value={systemId} onChange={event => setSystemId(Number(event.target.value))}/></label>
            {method === "LAN" && <p className="connection-settings-info">
              Direct local Wi-Fi requires the Pi TLS certificate to be trusted by the
              GCS backend. This path works without Oracle when the local network remains available.
            </p>}
            {(method === "UDP" || method === "TCP") && <p className="connection-settings-info">
              Local loopback only. This is not a remote IP connection.
            </p>}
            {role === "BACKUP" && <p className="connection-settings-info">
              Backup uses a different transport from primary. Switching the active receiver
              requires fresh MAVLink telemetry and explicit selection.
            </p>}
          </div>
          {(localError || error) && <p role="alert" className="connection-settings-error">
            {localError || error}
          </p>}
          {alreadyConfigured && <p className="connection-settings-info">
            This {role.toLowerCase()} receiver is configured. Disconnect the existing receiver
            before replacing its settings.
          </p>}
          {cannotAddBackup && <p className="connection-settings-info">
            Connect a primary receiver before configuring the standby link.
          </p>}
        </form>

        {(primaryExists || backupExists) && <div className="connection-settings-management">
          <span className="connection-settings-label">ACTIVE LINK MANAGEMENT</span>
          <div>
            {backupExists && <>
              <button type="button" disabled={busy || telemetry?.backup_status !== "LIVE" ||
                telemetry?.active_source === "BACKUP"} onClick={() => { void onActivate("BACKUP"); }}>
                Use backup
              </button>
              <button type="button" disabled={busy || telemetry?.primary_status !== "LIVE" ||
                telemetry?.active_source !== "BACKUP"} onClick={() => { void onActivate("PRIMARY"); }}>
                Restore primary
              </button>
              <button type="button" disabled={busy} onClick={() => { void onRemoveBackup(); }}>
                Remove backup
              </button>
            </>}
            <button type="button" disabled={busy} className="connection-disconnect"
              onClick={() => { void onDisconnect(); }}>Disconnect all</button>
          </div>
        </div>}
      </div>

      <footer className="connection-settings-footer">
        <p><UiIcon name="lock" size={14}/> Receive-only telemetry.
          No automatic flight-control takeover or aircraft command dispatch.</p>
        <div>
          <button type="button" className="connection-secondary"
            disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" form="connection-settings-form"
            className="connection-primary" disabled={busy || !aircraftId ||
              alreadyConfigured || cannotAddBackup}>
            {busy ? "Connecting…" : role === "PRIMARY" ? "Connect primary" : "Connect backup"}
          </button>
        </div>
      </footer>
    </section>
  </div>;
}
