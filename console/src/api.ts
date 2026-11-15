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
  mode: string | null;
  armed: boolean | null;
  age_ms: number | null;
  frames_total: number;
  rejected_frames: number;
  track_points: number;
  message_counts: Record<string, number>;
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
    throw new Error("Vihanga API unavailable. Start the backend on 127.0.0.1:8010.");
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
export const getHealth = () => request<Health>("health");
export const getVehicles = () => request<Vehicle[]>("vehicles");
export const getMissions = () => request<Mission[]>("missions");
export const getTelemetry = (id: string) => request<Telemetry>("telemetry/" + encodeURIComponent(id));
export const registerVehicle = (input: VehicleCreate) => jsonPost<{ vehicle_id: string }>("vehicles", input);
export const saveMission = (input: MissionCreate) => jsonPost<Mission>("missions", input);
export const previewSurvey = (input: {
  polygon: GeoPoint[]; spacing_m: number; angle_deg: number; altitude_m: number; speed_mps: number
}) => jsonPost<SurveyPreview>("surveys/preview", input);
export const previewCircularSurvey = (input: {
  polygon: GeoPoint[]; spacing_m: number; altitude_m: number; speed_mps: number
}) => jsonPost<SurveyPreview>("surveys/circular/preview", input);
export const connectCloud = (input: CloudSettings) => jsonPost<Telemetry>("links/cloud", input);
export const connectUDP = (input: UDPSettings) => jsonPost<Telemetry>("links/udp", input);
export const connectTCP = (input: TCPSettings) => jsonPost<Telemetry>("links/tcp", input);
export const connectSerial = (input: SerialSettings) => jsonPost<Telemetry>("links/serial", input);
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
