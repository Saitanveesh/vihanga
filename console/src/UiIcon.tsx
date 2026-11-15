import type { ReactNode } from "react";

export type IconName = "flight" | "plan" | "fleet" | "link" | "history" |
  "video" | "lock" | "shield" | "radio" | "database" | "map" | "activity";

const drawings: Record<IconName, ReactNode> = {
  flight: <><path d="M3 12l8.3-8.3a1 1 0 0 1 1.4 0L21 12l-8.3 8.3a1 1 0 0 1-1.4 0L3 12Z"/><path d="m9 12 3-3 3 3-3 3-3-3Z"/></>,
  plan: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/><path d="m5 13 4-3 3 2 6-4"/></>,
  fleet: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.6l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.6l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></>,
  history: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2.5"/></>,
  video: <><rect x="3" y="5" width="14" height="14" rx="2"/><path d="m17 10 4-2v8l-4-2z"/></>,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></>,
  shield: <><path d="m12 2 8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4Z"/><path d="m9 12 2 2 4-4"/></>,
  radio: <><circle cx="12" cy="12" r="2"/><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/></>,
  map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></>,
  activity: <><path d="M2 12h4l3-7 5 14 3-7h5"/></>
};

export default function UiIcon({ name, size = 20, className = "" }: {
  name: IconName; size?: number; className?: string;
}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{drawings[name]}</svg>;
}
