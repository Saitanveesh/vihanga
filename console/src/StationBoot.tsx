import { useEffect, useState } from "react";
import { getHealth, getMissions, getVehicles, type Health, type Mission, type Vehicle } from "./api";

export type BootData = { health?: Health; vehicles?: Vehicle[]; missions?: Mission[] };

export function useStationBoot(onResult: (data: BootData) => void) {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState({ initialized: false, finished: false, ready: false });

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    let cancelled = false;
    const deadline = window.setTimeout(() => controller.abort(), 5500);

    async function run() {
      const data: BootData = {};
      try {
        const health = await getHealth(signal);
        if (health.service === "vihanga-standalone" && health.status === "ok") data.health = health;
      } catch {
        // Keep startup recoverable when the operations API is unavailable.
      }
      if (cancelled) return;
      if (data.health) {
        const [fleet, drafts] = await Promise.allSettled([getVehicles(signal), getMissions(signal)]);
        if (fleet.status === "fulfilled" && Array.isArray(fleet.value)) data.vehicles = fleet.value;
        if (drafts.status === "fulfilled" && Array.isArray(drafts.value)) data.missions = drafts.value;
      }
      if (!cancelled) {
        onResult(data);
        setStatus({ initialized: true, finished: true, ready: Boolean(data.health && data.vehicles && data.missions) });
      }
    }
    void run().finally(() => window.clearTimeout(deadline));
    return () => {
      cancelled = true;
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [attempt, onResult]);

  return {
    ...status,
    retry: () => {
      setStatus(current => ({ ...current, finished: false, ready: false }));
      setAttempt(current => current + 1);
    }
  };
}
