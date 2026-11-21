import { useEffect, useRef, useState, type FormEvent } from "react";
import { getHostSerialPorts, type Telemetry } from "./api";
import UiIcon from "./UiIcon";
import { getBrowserSerial } from "./BrowserSerial";

export type ConnectionMethod = "SERIAL" | "BROWSER_USB" | "UDP" | "TCP" | "LAN" | "BROKER" | "CLOUD";
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
  onConnectBrowserSerial: (baud: number, systemId: number, useGranted?: boolean) => Promise<void>;
  onActivate: (role: ConnectionRole) => Promise<void>;
  onRemoveBackup: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onClose: () => void;
  onClearError?: () => void;
}

const methods: { id: ConnectionMethod; label: string; description: string;
  icon: "link" | "activity" | "database" | "radio" | "shield" }[] = [
  { id: "CLOUD", label: "Private relay", description: "Oracle operator relay", icon: "shield" },
  { id: "BROWSER_USB", label: "This PC USB", description: "Local telemetry", icon: "radio" },
  { id: "LAN", label: "Direct Wi-Fi", description: "Private Pi LAN", icon: "radio" },
  { id: "BROKER", label: "Vihanga Cloud", description: "Separate cloud broker", icon: "radio" },
  { id: "SERIAL", label: "Server USB", description: "API computer", icon: "link" },
  { id: "UDP", label: "UDP", description: "Local listener", icon: "activity" },
  { id: "TCP", label: "TCP", description: "Local client", icon: "database" },
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
        !/^https:\/\/(10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):(?:876[5-9]|877[0-5])\/?$/.test(input.origin.trim())) {
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
  onConnect, onConnectBrowserSerial, onActivate, onRemoveBackup, onDisconnect, onClose, onClearError
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
  const [serialPort, setSerialPort] = useState("");
  const [hostSerialPorts, setHostSerialPorts] = useState<string[]>([]);
  const [hostPlatform, setHostPlatform] = useState<string | null>(null);
  const [serialScanError, setSerialScanError] = useState("");
  const [serialScanBusy, setSerialScanBusy] = useState(false);
  const [serialScanRevision, setSerialScanRevision] = useState(0);
  const browserSerialAvailable = Boolean(getBrowserSerial());
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

  useEffect(() => {
    if (method !== "SERIAL") return;
    let cancelled = false;
    setSerialScanBusy(true);
    setSerialScanError("");
    getHostSerialPorts().then(result => {
      if (cancelled) return;
      setHostPlatform(result.host_platform);
      setHostSerialPorts(result.ports);
      setSerialPort(previous => result.ports.includes(previous)
        ? previous : result.ports.length === 1 ? result.ports[0] : "");
    }).catch(() => {
      if (cancelled) return;
      setHostSerialPorts([]);
      setHostPlatform(null);
      setSerialPort("");
      setSerialScanError("Unable to query the GCS backend for serial ports.");
    }).finally(() => { if (!cancelled) setSerialScanBusy(false); });
    return () => { cancelled = true; };
  }, [method, serialScanRevision]);

  function chooseMethod(next: ConnectionMethod) {
    setMethod(next);
    setOrigin(storedOrigin(next));
    setViewerToken("");
    setPassword("");
    setLocalError("");
    onClearError?.();
    if (next === "BROWSER_USB") setRole("BACKUP");
    if (next === "TCP") setPort(5760);
    if (next === "UDP") setPort(14550);
  }

  const selectedPrimary = telemetry?.active_source !== "BACKUP";
  const primaryExists = Boolean(telemetry?.primary_transport);
  const backupExists = Boolean(telemetry?.backup_transport);
  const alreadyConfigured = role === "PRIMARY" ? primaryExists : backupExists;
  const cannotAddBackup = role === "BACKUP" && !primaryExists;
  const commonMethods: ConnectionMethod[] = ["CLOUD", "BROWSER_USB", "LAN"];
  const advancedMethods: ConnectionMethod[] = ["BROKER", "SERIAL", "UDP", "TCP"];
  const advancedSelected = advancedMethods.includes(method);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!aircraftId || busy || alreadyConfigured || cannotAddBackup) return;
    if (method === "SERIAL" && (!hostSerialPorts.includes(serialPort) || serialScanBusy)) {
      setLocalError("Choose an available serial port attached to the GCS backend host.");
      return;
    }
    const request: ConnectionRequest = {
      role, method, origin: origin.trim(), username: username.trim(),
      password, viewerToken, serialPort: serialPort.trim(), baud, port, systemId
    };
    if (method === "BROWSER_USB") {
      if (role !== "BACKUP") {
        setLocalError("Choose Backup to attach this PC's serial telemetry radio.");
        return;
      }
      if (!browserSerialAvailable) {
        setLocalError("Chrome Web Serial is unavailable. Use desktop Chrome over HTTPS.");
        return;
      }
      setLocalError("");
      await onConnectBrowserSerial(baud, systemId);
      return;
    }
    const validationError = validateConnection(request);
    if (validationError) { setLocalError(validationError); return; }
    setLocalError("");
    await onConnect(request);
  }

  function receiverStatus(kind: "PRIMARY" | "BACKUP") {
    const status = kind === "PRIMARY" ? telemetry?.primary_status : telemetry?.backup_status;
    const transport = kind === "PRIMARY" ? telemetry?.primary_transport : telemetry?.backup_transport;
    const selected = Boolean(transport) && (kind === "PRIMARY" ? selectedPrimary : !selectedPrimary);
    const stateText = !transport ? "Not connected" : status === "LIVE" ? "Live telemetry" :
      status === "WAITING_FOR_FRAMES" ? "Waiting for aircraft" :
      status === "PARTIAL" ? "Telemetry incomplete" :
      status === "STALE" ? "Telemetry stale" : "No live telemetry";
    const transportText = transport === "BROWSER_SERIAL_READ_ONLY" ? "USB on this PC" :
      transport === "VIHANGA_CLOUD_V2" ? "Vihanga Cloud" :
      transport === "DIRECT_LAN_WSS" ? "Direct Wi-Fi" :
      transport?.replaceAll("_", " ") || "No receiver";
    return <div className={"connection-link-card " + (status === "LIVE" ? "live " : "") +
      (selected ? "is-selected" : "")}>
      <div className="connection-link-title">
        <span className={"connection-status-dot " + (status === "LIVE" ? "live" : "")}/>
        <strong>{kind === "PRIMARY" ? "Primary" : "Backup"}</strong>
        {selected && <span className="connection-selected">In use</span>}
      </div>
      <span className="connection-link-status">{stateText}</span>
      <small>{transportText}</small>
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
          <span className="connection-settings-label">RECEIVER</span>
          <div className="connection-role-switch" role="group" aria-label="Receiver assignment">
            {(["PRIMARY", "BACKUP"] as const).map(item =>
              <button type="button" key={item} onClick={() => {
                setRole(item); setLocalError(""); onClearError?.();
                if (item === "PRIMARY" && method === "BROWSER_USB") chooseMethod("CLOUD");
              }} aria-pressed={role === item} className={role === item ? "active" : ""}>
                {item === "PRIMARY" ? "Primary" : "Backup"}
              </button>
            )}
          </div>
        </div>

        {(primaryExists || backupExists) && <div className="connection-settings-management">
          <div>
            {backupExists && telemetry?.active_source !== "BACKUP" &&
              telemetry?.backup_status === "LIVE" && <button type="button" disabled={busy}
              onClick={() => { void onActivate("BACKUP"); }}>Use backup</button>}
            {backupExists && telemetry?.active_source === "BACKUP" &&
              telemetry?.primary_status === "LIVE" && <button type="button" disabled={busy}
              onClick={() => { void onActivate("PRIMARY"); }}>Restore primary</button>}
            {backupExists && <button type="button" disabled={busy}
              onClick={() => { void onRemoveBackup(); }}>Remove backup</button>}
            <button type="button" disabled={busy} className="connection-disconnect"
              onClick={() => { void onDisconnect(); }}>Disconnect all</button>
          </div>
        </div>}

        {alreadyConfigured ? <p className="connection-configured-note">
          {role === "PRIMARY" ? "Primary" : "Backup"} is already configured.
          Disconnect it before changing connection settings.
        </p> : cannotAddBackup ? <p className="connection-configured-note">
          Connect a primary receiver first.
        </p> : <>
        <div className="connection-settings-section">
          <span className="connection-settings-label">CONNECT USING</span>
          <div className="connection-settings-methods" role="group" aria-label="Connection method">
            {methods.filter(item => commonMethods.includes(item.id)).map(item =>
              <button key={item.id} type="button" aria-pressed={method === item.id}
                className={method === item.id ? "active" : ""}
                onClick={() => chooseMethod(item.id)}>
                <UiIcon name={item.icon} size={18}/>
                <span><strong>{item.label}</strong></span>
              </button>)}
          </div>
          <details className="connection-advanced-methods" open={advancedSelected ? true : undefined}>
            <summary>Advanced connections</summary>
            <div className="connection-settings-methods" role="group" aria-label="Advanced connection methods">
              {methods.filter(item => advancedMethods.includes(item.id)).map(item =>
                <button key={item.id} type="button" aria-pressed={method === item.id}
                  className={method === item.id ? "active" : ""}
                  onClick={() => chooseMethod(item.id)}>
                  <UiIcon name={item.icon} size={18}/>
                  <span><strong>{item.label}</strong></span>
                </button>)}
            </div>
          </details>
        </div>

        <form id="connection-settings-form" onSubmit={event => { void submit(event); }}
          className="connection-settings-form">
          <div className="connection-settings-section">
            <span className="connection-settings-label">CONNECTION DETAILS</span>
            {method === "BROWSER_USB" && <>
              <label>Telemetry baud rate
                <select value={baud} onChange={event => setBaud(Number(event.target.value))}>
                  {[9600,19200,38400,57600,115200,230400,460800,921600].map(value =>
                    <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <p className="connection-inline-note">
                Choose the USB adapter in Chrome's port picker. This PC reads telemetry only.
              </p>
              {!browserSerialAvailable && <p role="alert" className="connection-settings-error">
                Use a desktop Chromium browser with Web Serial on HTTPS.
              </p>}
            </>}
            {method === "SERIAL" && <>
              <div className="connection-settings-field-grid">
                <label>Detected API-host serial port
                  <select required aria-label="Detected serial port" value={serialPort}
                    disabled={serialScanBusy || hostSerialPorts.length === 0}
                    onChange={event => setSerialPort(event.target.value)}>
                    <option value="">{serialScanBusy ? "Scanning..." : "Choose detected port"}</option>
                    {hostSerialPorts.map(value =>
                      <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label>Baud rate<select value={baud}
                  onChange={event => setBaud(Number(event.target.value))}>
                  {[9600,19200,38400,57600,115200,230400,460800,921600].map(value =>
                    <option value={value} key={value}>{value}</option>)}
                </select></label>
              </div>
              <button className="connection-scan-button" type="button"
                disabled={serialScanBusy} onClick={() => setSerialScanRevision(x => x + 1)}>
                {serialScanBusy ? "Scanning" : "Rescan serial ports"}
              </button>
              {serialScanError && <p role="status" className="connection-settings-info">{serialScanError}</p>}
              {hostPlatform === "LINUX" && <p className="connection-inline-note">
                Server USB scans Oracle/Linux, not this PC. Use This PC USB for a Windows radio.
              </p>}
            </>}
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
            <details className="connection-advanced-settings">
              <summary>FC MAVLink system ID: {systemId}</summary>
              <label>FC MAVLink system ID<input type="number" required min={1} max={254}
                value={systemId} onChange={event => setSystemId(Number(event.target.value))}/></label>
            </details>
            {method === "LAN" && <p className="connection-inline-note">
              Requires a trusted Pi HTTPS connection on the local network.
            </p>}
            {(method === "UDP" || method === "TCP") && <p className="connection-inline-note">
              Connects only to 127.0.0.1 on the API host.
            </p>}
          </div>
          {(localError || error) && <p role="alert" className="connection-settings-error">
            {localError || error}
          </p>}
        </form>
        </>}

      </div>

      <footer className="connection-settings-footer">
        <p><UiIcon name="lock" size={14}/> Telemetry only. No flight commands.</p>
        <div>
          <button type="button" className="connection-secondary"
            disabled={busy} onClick={onClose}>Close</button>
          {!alreadyConfigured && !cannotAddBackup && <button type="submit" form="connection-settings-form"
            className="connection-primary" disabled={busy || !aircraftId ||
              (method === "BROWSER_USB" && (role !== "BACKUP" || !browserSerialAvailable)) ||
              (method === "SERIAL" && (!hostSerialPorts.includes(serialPort) || serialScanBusy))}>
            {busy ? "Connecting…" : method === "BROWSER_USB" ? "Connect USB" : role === "PRIMARY" ? "Connect primary" : "Connect backup"}
          </button>}
        </div>
      </footer>
    </section>
  </div>;
}
