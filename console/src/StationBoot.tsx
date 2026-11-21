import StationMark from "./StationMark";
import { useEffect, useState } from "react";
import { getHealth, getMissions, getVehicles, type Health, type Mission, type Vehicle } from "./api";

type Check = { state: "pending" | "ready" | "failed"; detail: string };
type BootChecks = { api: Check; fleet: Check; drafts: Check };
export type BootData = { health?: Health; vehicles?: Vehicle[]; missions?: Mission[] };

const initialChecks: BootChecks = {
  api: { state: "pending", detail: "Checking the local service" },
  fleet: { state: "pending", detail: "Waiting for the operations API" },
  drafts: { state: "pending", detail: "Waiting for the operations API" }
};

export function useStationBoot(onResult: (data: BootData) => void) {
  const [checks, setChecks] = useState(initialChecks);
  const [attempt, setAttempt] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const deadline = window.setTimeout(() => controller.abort(), 5500);
    const signal = controller.signal;

    function report(key: keyof BootChecks, state: Check["state"], detail: string) {
      if (!cancelled) {
        setChecks(current => ({ ...current, [key]: { state, detail } }));
      }
    }
    async function run() {
      const data: BootData = {};
      try {
        const health = await getHealth(signal);
        if (health.service !== "vihanga-standalone" || health.status !== "ok") {
          throw new Error("Unexpected service response");
        }
        data.health = health;
        report("api", "ready", "Local service responding");
      } catch {
        report("api", "failed", "Check that the local Vihanga service is running");
        report("fleet", "failed", "Aircraft directory unavailable");
        report("drafts", "failed", "Mission drafts unavailable");
      }
      if (cancelled) return;
      if (data.health) {
        await Promise.all([
          getVehicles(signal).then(vehicles => {
            if (!Array.isArray(vehicles)) throw new Error("Invalid aircraft directory");
            data.vehicles = vehicles;
            report("fleet", "ready", vehicles.length === 1 ? "1 aircraft" : vehicles.length + " aircraft");
          }).catch(() => report("fleet", "failed", "Could not load aircraft directory")),
          getMissions(signal).then(missions => {
            if (!Array.isArray(missions)) throw new Error("Invalid mission drafts");
            data.missions = missions;
            report("drafts", "ready", missions.length + (missions.length === 1 ? " saved draft" : " saved drafts"));
          }).catch(() => report("drafts", "failed", "Could not load saved drafts"))
        ]);
      }
      if (!cancelled) {
        onResult(data);
        setFinished(true);
      }
    }
    void run().finally(() => window.clearTimeout(deadline));
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(deadline);
    };
  }, [attempt, onResult]);

  const ready = Object.values(checks).every(check => check.state === "ready");
  return {
    checks, finished, ready, dismissed,
    dismiss: () => setDismissed(true),
    retry: () => {
      setFinished(false);
      setChecks(initialChecks);
      setAttempt(value => value + 1);
    }
  };
}

export default function StationBoot({ checks, finished, ready, dismiss, retry }: ReturnType<typeof useStationBoot>) {
  const checked = Object.values(checks).filter(check => check.state !== "pending").length;
  return <main className="station-boot">
    <section className="station-boot-inner" aria-labelledby="station-boot-title">
      <StationMark phase={!finished ? "checking" : ready ? "ready" : "attention"}/>
      <h1 id="station-boot-title">Station startup</h1>
      <div className="station-start-progress">
        <progress aria-label="Startup checks completed" max={3} value={checked}/>
        <span>{checked} / 3 checked</span>
      </div>
      <ol aria-live="polite" className="boot-checks">
        {([["api", "Operations API"], ["fleet", "Aircraft directory"], ["drafts", "Mission storage"]] as const)
          .map(([key, label]) => <li key={key} data-state={checks[key].state}>
            <span className="boot-indicator" aria-hidden="true"/>
            <div><strong>{label}</strong><small>{checks[key].detail}</small></div>
            <span>{checks[key].state === "ready" ? "READY" : checks[key].state === "failed" ? "UNAVAILABLE" : "PENDING"}</span>
          </li>)}
      </ol>
      {finished && <div className="boot-actions">
        {ready
          ? <button type="button" onClick={dismiss}>Open ground station</button>
          : <><button type="button" onClick={retry}>Retry checks</button>
            <button type="button" className="boot-secondary" onClick={dismiss}>Open workspace</button></>}
      </div>}
    </section>
  </main>;
}
