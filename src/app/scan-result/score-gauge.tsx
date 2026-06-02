"use client";

import { useEffect, useState } from "react";
import { NumberTicker } from "./number-ticker";
import { severityOfScore, type Severity } from "./severity";

const SEVERITY_STROKE: Record<Severity, string> = {
  clear: "var(--clear)",
  suspect: "var(--suspect)",
  fraud: "var(--fraud)",
};

const SEVERITY_VERDICT: Record<Severity, string> = {
  clear: "Authentic",
  suspect: "Needs review",
  fraud: "Likely forged",
};

// Circular fraud-score dial. The arc sweeps to fill proportionally to the score
// and snaps to the severity color (teal / amber / vermilion) as the number locks in.
export function ScoreGauge({
  score,
  startDelayMs = 0,
}: {
  score: number;
  startDelayMs?: number;
}) {
  const severity = severityOfScore(score);
  const stroke = SEVERITY_STROKE[severity];

  // Geometry: a 270° arc (leaving a 90° gap at the bottom) reads as an instrument dial.
  const size = 240;
  const radius = 100;
  const cx = size / 2;
  const cy = size / 2;
  const arcSpan = 0.75; // 270° of the full circle
  const circumference = 2 * Math.PI * radius;
  const trackLength = circumference * arcSpan;

  const [progress, setProgress] = useState(0); // 0 → 1 fill ratio

  useEffect(() => {
    const prefersReduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduced) {
      setProgress(score / 100);
      return;
    }
    const t = window.setTimeout(() => setProgress(score / 100), startDelayMs);
    return () => window.clearTimeout(t);
  }, [score, startDelayMs]);

  const dashOffset = trackLength * (1 - progress);
  // Rotate so the gap sits at the bottom and the arc starts bottom-left.
  const rotation = 135;

  return (
    <div className="relative flex flex-col items-center">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`Fraud score ${score} out of 100, ${SEVERITY_VERDICT[severity]}`}
        className="drop-shadow-[0_0_24px_rgba(56,189,207,0.10)]"
      >
        {/* Track */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={`${trackLength} ${circumference}`}
          transform={`rotate(${rotation} ${cx} ${cy})`}
        />
        {/* Severity fill */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth={14}
          strokeLinecap="round"
          strokeDasharray={`${trackLength} ${circumference}`}
          strokeDashoffset={dashOffset}
          transform={`rotate(${rotation} ${cx} ${cy})`}
          style={{
            transition:
              "stroke-dashoffset 1400ms cubic-bezier(0.22,1,0.36,1), stroke 400ms ease",
          }}
        />
      </svg>

      {/* Center readout — absolutely positioned over the dial */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="font-mono text-[0.7rem] uppercase tracking-[0.18em] text-muted-foreground"
        >
          Fraud score
        </span>
        <div
          className="font-heading text-7xl font-bold leading-none"
          style={{ color: stroke, letterSpacing: "-0.02em" }}
        >
          <NumberTicker value={score} delayMs={startDelayMs} />
        </div>
        <span
          className="mt-1 rounded-pill px-3 py-1 font-mono text-xs font-medium uppercase tracking-wide"
          style={{ color: stroke, backgroundColor: "color-mix(in oklch, " + stroke + " 14%, transparent)" }}
        >
          {SEVERITY_VERDICT[severity]}
        </span>
      </div>
    </div>
  );
}
