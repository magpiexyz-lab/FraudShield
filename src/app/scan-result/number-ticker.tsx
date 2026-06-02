"use client";

import { useEffect, useRef, useState } from "react";

// Forensic "Score Lock-in" count-up. Counts from 0 → target with a snappy
// soft-settle easing (matches the visual brief's cubic-bezier(0.22,1,0.36,1)).
// Reduced-motion: snaps straight to the value, no animation loop.
export function NumberTicker({
  value,
  durationMs = 1400,
  delayMs = 0,
  className,
}: {
  value: number;
  durationMs?: number;
  delayMs?: number;
  className?: string;
}) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReduced) {
      setDisplay(value);
      return;
    }

    // easeOutQuint — fast in, soft settle on the final value.
    const ease = (t: number) => 1 - Math.pow(1 - t, 5);

    let cancelled = false;
    const begin = (now: number) => {
      startRef.current = now;
      const step = (frame: number) => {
        if (cancelled || startRef.current === null) return;
        const elapsed = frame - startRef.current;
        const t = Math.min(1, elapsed / durationMs);
        setDisplay(Math.round(ease(t) * value));
        if (t < 1) {
          rafRef.current = requestAnimationFrame(step);
        }
      };
      rafRef.current = requestAnimationFrame(step);
    };

    const timeout = window.setTimeout(
      () => begin(performance.now()),
      delayMs,
    );

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, durationMs, delayMs]);

  return (
    <span className={className} style={{ fontVariantNumeric: "tabular-nums" }}>
      {display}
    </span>
  );
}
