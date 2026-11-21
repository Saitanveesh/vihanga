import { useEffect, useLayoutEffect, useRef, useState } from "react";

const reducedMotion = "(prefers-reduced-motion: reduce)";
const revealDuration = 1150;
const exitDuration = 330;

export default function BootSplash({ ready, onComplete }: { ready: boolean; onComplete: () => void }) {
  const surface = useRef<HTMLElement>(null);
  const scene = useRef<HTMLDivElement>(null);
  const wordmark = useRef<HTMLHeadingElement>(null);
  const orbit = useRef<HTMLSpanElement>(null);
  const [animate, setAnimate] = useState(() =>
    typeof HTMLElement.prototype.animate === "function" && !window.matchMedia?.(reducedMotion).matches
  );
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    const preference = window.matchMedia?.(reducedMotion);
    const update = () => setAnimate(typeof HTMLElement.prototype.animate === "function" && !preference?.matches);
    preference?.addEventListener?.("change", update);
    return () => preference?.removeEventListener?.("change", update);
  }, []);

  useLayoutEffect(() => {
    if (!animate || !scene.current || !wordmark.current || !orbit.current) return;
    const reveal = scene.current.animate([
      { opacity: 0, transform: "translateY(14px) scale(.94)" },
      { opacity: 1, transform: "translateY(0) scale(1)" }
    ], { duration: 800, easing: "cubic-bezier(.18,.72,.22,1)", fill: "both" });
    const sweep = wordmark.current.animate([
      { backgroundPosition: "100% 50%" },
      { backgroundPosition: "0% 50%" }
    ], { duration: 950, delay: 150, easing: "cubic-bezier(.35,0,.25,1)", fill: "both" });
    const spin = orbit.current.animate([
      { transform: "rotate(-30deg)" },
      { transform: "rotate(330deg)" }
    ], { duration: 1600, iterations: Infinity });
    const timer = window.setTimeout(() => setRevealed(true), revealDuration);
    return () => {
      window.clearTimeout(timer);
      reveal.cancel();
      sweep.cancel();
      spin.cancel();
    };
  }, [animate]);

  useLayoutEffect(() => {
    if (!ready) return;
    if (!animate) {
      onComplete();
      return;
    }
    if (!revealed || !surface.current || !scene.current) return;
    const fade = surface.current.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: exitDuration, easing: "ease-in-out", fill: "forwards"
    });
    const drift = scene.current.animate([
      { transform: "scale(1)" },
      { transform: "scale(1.035)" }
    ], { duration: exitDuration, easing: "ease-out", fill: "forwards" });
    const timer = window.setTimeout(onComplete, exitDuration);
    return () => {
      window.clearTimeout(timer);
      fade.cancel();
      drift.cancel();
    };
  }, [animate, ready, revealed, onComplete]);

  return <main className="station-splash" aria-busy="true" ref={surface}>
    <div className="station-splash-scene" ref={scene}>
      <h1 className="station-splash-wordmark" ref={wordmark}>VIHANGA</h1>
      <div className="station-splash-orbit" aria-hidden="true"><span ref={orbit}/></div>
    </div>
  </main>;
}
