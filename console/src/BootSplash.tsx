import { useEffect, useLayoutEffect, useRef, useState } from "react";

const reducedMotion = "(prefers-reduced-motion: reduce)";
const revealDuration = 950;
const displayDuration = 1150;
const exitDuration = 240;

function canAnimate(preference = window.matchMedia?.(reducedMotion)) {
  return typeof Element.prototype.animate === "function" && !preference?.matches;
}

export default function BootSplash({ ready, onComplete }: { ready: boolean; onComplete: () => void }) {
  const surface = useRef<HTMLElement>(null);
  const logo = useRef<SVGSVGElement>(null);
  const [motion, setMotion] = useState(() => canAnimate());
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia?.(reducedMotion);
    const update = () => setMotion(canAnimate(preference));
    preference?.addEventListener?.("change", update);
    return () => preference?.removeEventListener?.("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!motion || !logo.current) return;
    const reveal = logo.current.animate([
      { opacity: 0, transform: "scale(.96)" },
      { opacity: 1, transform: "scale(1)" }
    ], { duration: revealDuration, easing: "cubic-bezier(.35,0,.25,1)", fill: "both" });
    const timer = window.setTimeout(() => setRevealed(true), displayDuration);
    return () => {
      window.clearTimeout(timer);
      reveal.cancel();
    };
  }, [motion]);

  useLayoutEffect(() => {
    if (!ready) return;
    if (!motion) {
      onComplete();
      return;
    }
    if (!revealed || !logo.current || !surface.current) return;
    const options: KeyframeAnimationOptions = { duration: exitDuration, easing: "ease-in-out", fill: "forwards" };
    const fade = logo.current.animate([{ opacity: 1 }, { opacity: 0 }], options);
    const unveil = surface.current.animate([
      { backgroundColor: "#000" }, { backgroundColor: "transparent" }
    ], options);
    const timer = window.setTimeout(onComplete, exitDuration);
    return () => {
      window.clearTimeout(timer);
      fade.cancel();
      unveil.cancel();
    };
  }, [motion, ready, revealed, onComplete]);

  return <main className="station-splash" aria-busy="true" ref={surface}>
    <svg className="station-splash-logo" ref={logo} viewBox="8 23 80 56" width="208" height="146"
      role="img" aria-label="VIHANGA">
      <defs>
        <linearGradient id="boot-wing" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#9ad9f3"/>
          <stop offset="1" stopColor="#448ebc"/>
        </linearGradient>
      </defs>
      <g fill="url(#boot-wing)">
        <path d="M10 38 37 43 48 27 58 43 86 38 68 51 60 52 48 71 36 52 28 51Z"/>
        <path d="m21 54 17 4 10 15 10-15 17-4-20 3-7 16-7-16Z" opacity=".57"/>
      </g>
      <path d="m39 45 9-13 9 13-9-3Z" fill="#d7eff9"/>
      <path d="M48 54v16" fill="none" stroke="#09141f" strokeWidth="4" strokeLinecap="round"/>
      <path d="M47 74h2" stroke="#8dcbe9" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  </main>;
}
