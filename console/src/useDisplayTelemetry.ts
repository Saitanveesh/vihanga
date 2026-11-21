import { useEffect, useMemo, useState } from "react";
import type { Telemetry } from "./api";
import { currentTelemetry, MAX_PACKET_AGE_MS } from "./flightHistory";

export default function useDisplayTelemetry(telemetry?: Telemetry) {
  const received = useMemo(() => telemetry ? { telemetry, at: performance.now() } : null, [telemetry]);
  const [expired, setExpired] = useState<typeof received>(null);

  useEffect(() => {
    if (!received || !currentTelemetry(received.telemetry)) return;
    const age = received.telemetry.age_ms;
    if (age == null) return;
    const remaining = MAX_PACKET_AGE_MS - age - (performance.now() - received.at);
    const timer = window.setTimeout(() => setExpired(received), Math.max(0, remaining) + 1);
    return () => window.clearTimeout(timer);
  }, [received]);

  if ((telemetry?.status === "LIVE" || telemetry?.status === "PARTIAL") &&
      (received === expired || !currentTelemetry(telemetry))) {
    return { ...telemetry, status: "STALE", heartbeat_fresh: false, attitude_fresh: false };
  }
  return telemetry;
}
