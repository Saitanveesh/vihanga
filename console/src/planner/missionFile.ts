import type { Telemetry, Waypoint } from "../api";

export function missionPlannerFile(home: NonNullable<Telemetry["home"]>, route: Waypoint[]) {
  if (route.length < 2) throw new Error("A route needs at least two waypoints.");
  function row(index: number, latitude: number, longitude: number, altitude: number) {
    if (![latitude, longitude, altitude].every(Number.isFinite) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error("Invalid route coordinates.");
    return [index, index === 0 ? 1 : 0, index === 0 ? 0 : 3, 16, 0, 0, 0, 0,
      latitude.toFixed(7), longitude.toFixed(7), altitude.toFixed(3), 1].join("\t");
  }
  return ["QGC WPL 110", row(0, home.latitude, home.longitude, home.altitude_msl_m),
    ...route.map((p, i) => row(i + 1, p.latitude, p.longitude, p.altitude_m))].join("\r\n") + "\r\n";
}
