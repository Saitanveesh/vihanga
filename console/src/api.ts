export interface Health {
  service: string;
  status: string;
  deployment: string;
  physical_flight_control: boolean;
  live_vehicle_stream: boolean;
}
export interface Vehicle {
  vehicle_id: string;
  label: string;
  autopilot: string;
  interface: string;
  created_at: string;
  link_state: string;
  control_authorized: false;
}
export interface Waypoint {
  latitude: number;
  longitude: number;
  altitude_m: number;
}
export interface GeoPoint {
  latitude: number;
  longitude: number;
}
export interface Mission {
  mission_id: string;
  vehicle_id: string;
  title: string;
  waypoints: Waypoint[];
  revision_sha256: string;
  created_at: string;
  distance_m: number;
  status: "DRAFT_ONLY";
}
export interface SurveyPreview {
  waypoints: Waypoint[];
  polygon: GeoPoint[];
  lane_count: number;
  route_distance_m: number;
  area_m2: number;
  estimated_duration_s: number;
  pattern?: string;
  coverage_note?: string;
  requires_route_review: boolean;
  status: "PREVIEW_ONLY";
}
export interface VehicleCreate {
  vehicle_id: string;
  label: string;
  autopilot: "ARDUPILOT" | "PX4" | "OTHER";
  interface: "UART" | "USB" | "ETHERNET" | "OTHER";
}
export interface MissionCreate {
  vehicle_id: string;
  title: string;
  waypoints: Waypoint[];
}
export interface Telemetry {
  vehicle_id: string;
  transport: string | null;
  status: string;
  error_code: string | null;
  flight_control_enabled: false;
  heartbeat_fresh: boolean;
  attitude_fresh: boolean;
  latitude: number | null;
  longitude: number | null;
  roll_deg: number | null;
  pitch_deg: number | null;
  yaw_deg: number | null;
  relative_alt_m: number | null;
  groundspeed_mps: number | null;
  climb_mps: number | null;
  voltage_v: number | null;
  battery_pct: number | null;
  gps_fix_type: number | null;
  satellites: number | null;
  gps2_fix_type: number | null;
  gps2_satellites: number | null;
  battery_current_a: number | null;
  /** FC-reported RC receiver input; not a GCS backup transport. */
  rc_input_status?: "NOT_REPORTED" | "CHANNELS_REPORTED" | "FC_HEALTHY" | "FC_FAULT" | "FC_DISABLED" | "FC_ABSENT" | "FAILSAFE";
  rc_failsafe_reported?: boolean | null;
  rc_channels_fresh?: boolean;
  rc_channel_count?: number | null;
  rc_rssi_raw?: number | null;
  rc_message_type?: "RC_CHANNELS" | "RC_CHANNELS_RAW" | null;
  radio_rssi_raw?: number | null;
  radio_remote_rssi_raw?: number | null;
  radio_noise_raw?: number | null;
  radio_rx_errors?: number | null;
  radio_fixed_packets?: number | null;
  radio_txbuf_raw?: number | null;
  sensor_health?: Record<string, "HEALTHY" | "FAULT" | "DISABLED" | "ABSENT"> | null;
  active_source?: "PRIMARY" | "BACKUP";
  primary_status?: string;
  primary_transport?: string | null;
  primary_heartbeat_fresh?: boolean;
  primary_attitude_fresh?: boolean;
  backup_status?: string;
  backup_transport?: string | null;
  backup_error_code?: string | null;
  backup_heartbeat_fresh?: boolean;
  backup_attitude_fresh?: boolean;
  backup_frame_rate_5s_hz?: number | null;
  backup_age_ms?: number | null;
  airspeed_mps: number | null;
  throttle_pct: number | null;
  frame_rate_5s_hz: number;
  mode: string | null;
  armed: boolean | null;
  age_ms: number | null;
  frames_total: number;
  rejected_frames: number;
  track_points: number;
  message_counts: Record<string, number>;
}
export interface BrokerSettings {
  vehicle_id: string;
  origin: string;
  viewer_token: string;
  fc_system_id: number;
}
export interface CloudSettings {
  vehicle_id: string;
  origin: string;
  username: string;
  password: string;
  fc_system_id: number;
}
export interface UDPSettings {
  vehicle_id: string;
  port: number;
  fc_system_id: number;
}
export interface TCPSettings {
  vehicle_id: string;
  port: number;
  fc_system_id: number;
}
export interface SerialSettings {
  vehicle_id: string;
  port: string;
  baud: number;
  fc_system_id: number;
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/v1/" + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) }
    });
  } catch {
    throw new Error("The local Vihanga operations API is unreachable.");
  }
  const data: unknown = await response.json();
  if (!response.ok) {
    const failure = data as { detail?: unknown };
    throw new Error(typeof failure.detail === "string" ? failure.detail : "Request rejected (" + response.status + ")");
  }
  return data as T;
}
const jsonPost = <T,>(path: string, value: unknown): Promise<T> => request<T>(path, {
  method: "POST", body: JSON.stringify(value)
});
export interface HostSerialPorts {
  host_platform: string;
  ports: string[];
  scope: "API_HOST_ONLY";
}
export const getHostSerialPorts = () => request<HostSerialPorts>("serial/ports");
export const getHealth = (signal?: AbortSignal) => request<Health>("health", { signal, cache: "no-store" });
export const getVehicles = (signal?: AbortSignal) => request<Vehicle[]>("vehicles", { signal, cache: "no-store" });
export const getMissions = (signal?: AbortSignal) => request<Mission[]>("missions", { signal, cache: "no-store" });
export const getTelemetry = (id: string) => request<Telemetry>("telemetry/" + encodeURIComponent(id));
export const getFleetTelemetry = (signal?: AbortSignal) => request<Record<string, Telemetry>>("fleet/telemetry", { signal, cache: "no-store" });
export const registerVehicle = (input: VehicleCreate) => jsonPost<{ vehicle_id: string }>("vehicles", input);
export const saveMission = (input: MissionCreate) => jsonPost<Mission>("missions", input);
export const previewSurvey = (input: {
  polygon: GeoPoint[]; spacing_m: number; angle_deg: number; altitude_m: number; speed_mps: number
}) => jsonPost<SurveyPreview>("surveys/preview", input);
export const previewCircularSurvey = (input: {
  polygon: GeoPoint[]; spacing_m: number; altitude_m: number; speed_mps: number
}) => jsonPost<SurveyPreview>("surveys/circular/preview", input);
export const connectBroker = (input: BrokerSettings) => jsonPost<Telemetry>("links/broker", input);
export const connectCloud = (input: CloudSettings) => jsonPost<Telemetry>("links/cloud", input);
export const connectUDP = (input: UDPSettings) => jsonPost<Telemetry>("links/udp", input);
export const connectTCP = (input: TCPSettings) => jsonPost<Telemetry>("links/tcp", input);
export const connectSerial = (input: SerialSettings) => jsonPost<Telemetry>("links/serial", input);
export type ReceiveTransport = "BROKER" | "CLOUD" | "LAN" | "SERIAL" | "UDP" | "TCP";
export type ReceiveConfig = BrokerSettings | CloudSettings | UDPSettings | TCPSettings | SerialSettings;
export const connectLAN = (input: BrokerSettings) => jsonPost<Telemetry>("links/lan", input);
export const connectBackupLAN = (input: BrokerSettings) => jsonPost<Telemetry>("links/backup/lan", input);
export const connectBackupBroker = (input: BrokerSettings) => jsonPost<Telemetry>("links/backup/broker", input);
export const connectBackupCloud = (input: CloudSettings) => jsonPost<Telemetry>("links/backup/cloud", input);
export const connectBackupUDP = (input: UDPSettings) => jsonPost<Telemetry>("links/backup/udp", input);
export const connectBackupTCP = (input: TCPSettings) => jsonPost<Telemetry>("links/backup/tcp", input);
export const connectBackupSerial = (input: SerialSettings) => jsonPost<Telemetry>("links/backup/serial", input);
export const activateTelemetrySource = (id: string, role: "PRIMARY" | "BACKUP") =>
  jsonPost<Telemetry>("links/select/" + encodeURIComponent(id) + "/" + role, {});
export const disconnectBackup = (id: string) =>
  request<Telemetry>("links/backup/" + encodeURIComponent(id), {method: "DELETE"});
export const disconnectLink = (id: string) => request<Telemetry>("links/" + encodeURIComponent(id), {method: "DELETE"});


export interface ObservedTrack {
  vehicle_id: string;
  status: string;
  points: GeoPoint[];
  count: number;
  warning: string;
}
export const getObservedTrack = (id: string) =>
  request<ObservedTrack>("flight-tracks/" + encodeURIComponent(id));

export type OperatorGroup = "FLIGHT" | "NAVIGATION" | "MISSIONS" | "PARAMETERS" | "DIAGNOSTICS" | "SETUP" | "LOGS";
export type BenchReadKind =
  "FC_VERSION" | "STATUS" | "GPS" | "GPS2" | "EKF" | "RC" |
  "BATTERY" | "HOME" | "EXTENDED_STATE" | "PARAMETER_LIST" |
  "PARAMETER_READ" | "MISSION_SUMMARY";
export interface OperatorAction {
  code: string;
  label: string;
  group: OperatorGroup;
  risk: "READ" | "HIGH" | "CRITICAL";
  requirement: string;
  enabled: boolean;
  status: "READY" | "LOCKED";
  reason: string;
  bench_query: BenchReadKind | null;
}
export interface OperatorCatalog {
  vehicle_id: string;
  physical_flight_control_enabled: false;
  cloud_command_dispatch_enabled: false;
  read_only_bench_enabled: boolean;
  operations: OperatorAction[];
}
export interface ParameterReadback {
  vehicle_id: string;
  status: string;
  received: number;
  reported_total: number | null;
  items: Record<string, {value: number; type: number}>;
  warning?: string;
}
export interface BenchReceipt {
  vehicle_id: string;
  result: "SERIAL_WRITE_COMPLETED";
  bytes_written: number;
  fc_acknowledged: false;
  flight_control_enabled: false;
  query: BenchReadKind;
  warning: string;
}
export const getOperatorCatalog = (id: string) =>
  request<OperatorCatalog>("operator/" + encodeURIComponent(id) + "/catalog");
export const getParameterReadback = (id: string) =>
  request<ParameterReadback>("operator/" + encodeURIComponent(id) + "/parameters");
export const sendBenchRead = (id: string, query: BenchReadKind, parameter?: string) =>
  request<BenchReceipt>("operator/" + encodeURIComponent(id) + "/bench-query", {
    method: "POST",
    headers: {"X-Vihanga-Bench-Read": "confirm-non-actuating-request"},
    body: JSON.stringify({query, ...(parameter ? {parameter} : {})})
  });
