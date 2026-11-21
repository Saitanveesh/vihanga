import { useEffect, useLayoutEffect, useRef, useState } from "react";

const reducedMotion = "(prefers-reduced-motion: reduce)";
const revealDuration = 950;
const displayDuration = 1150;
const exitDuration = 240;

function canAnimate(preference = window.matchMedia?.(reducedMotion)) {
  return typeof HTMLElement.prototype.animate === "function" && !preference?.matches;
}

export default function BootSplash({ ready, onComplete }: { ready: boolean; onComplete: () => void }) {
  const logo = useRef<HTMLImageElement>(null);
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
    if (!revealed || !logo.current) return;
    const fade = logo.current.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: exitDuration, easing: "ease-in-out", fill: "forwards"
    });
    const timer = window.setTimeout(onComplete, exitDuration);
    return () => {
      window.clearTimeout(timer);
      fade.cancel();
    };
  }, [motion, ready, revealed, onComplete]);

  return <main className="station-splash" aria-busy="true">
    <img className="station-splash-logo" ref={logo} src="/vihanga-boot.svg" alt="VIHANGA" width="208" height="146"/>
  </main>;
}
