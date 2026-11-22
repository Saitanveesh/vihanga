import { useEffect, useRef } from "react";

type Phase = "checking" | "ready" | "attention" | "idle";

export default function StationMark({ phase }: { phase: Phase }) {
  const logo = useRef<HTMLImageElement>(null);
  const scanner = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let animations: Animation[] = [];
    function sync() {
      animations.forEach(animation => animation.cancel());
      animations = [];
      if (preference?.matches) return;
      if (phase === "checking" && scanner.current?.animate) {
        animations.push(scanner.current.animate(
          [{ transform: "rotate(-70deg)" }, { transform: "rotate(290deg)" }],
          { duration: 2400, iterations: Infinity }
        ));
      }
      if (logo.current?.animate && (phase === "checking" || phase === "ready")) {
        const frames = phase === "checking"
          ? [{ opacity: 0.4, transform: "scale(.82) translateY(8px)" },
             { opacity: 1, transform: "scale(1) translateY(0)" }]
          : [{ transform: "scale(.98)" }, { transform: "scale(1.08)", offset: .45 },
             { transform: "scale(1)" }];
        animations.push(logo.current.animate(frames, {
          duration: phase === "checking" ? 580 : 420,
          easing: "cubic-bezier(.2,.72,.25,1)"
        }));
      }
    }
    sync();
    preference?.addEventListener?.("change", sync);
    return () => {
      preference?.removeEventListener?.("change", sync);
      animations.forEach(animation => animation.cancel());
    };
  }, [phase]);

  return <div className="station-mark" data-phase={phase}>
    <div className="station-emblem" aria-hidden="true">
      <span className="station-emblem-ring"/>
      <span className="station-emblem-scan" ref={scanner}/>
      <img ref={logo} src="/vihanga-mark.svg" width="74" height="74" alt=""/>
    </div>
    <div className="station-mark-name"><strong>VIHANGA</strong><span>GROUND STATION</span></div>
  </div>;
}
