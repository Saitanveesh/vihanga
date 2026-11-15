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
  link_state: "OFFLINE";
  control_authorized: false;
}
export interface Waypoint {
  latitude: number;
  longitude: number;
  altitude_m: number;
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
export const getHealth = () => request<Health>("health");
export const getVehicles = () => request<Vehicle[]>("vehicles");
export const getMissions = () => request<Mission[]>("missions");
export const registerVehicle = (input: VehicleCreate) => request<{ vehicle_id: string }>("vehicles", { method: "POST", body: JSON.stringify(input) });
export const saveMission = (input: MissionCreate) => request<Mission>("missions", { method: "POST", body: JSON.stringify(input) });
