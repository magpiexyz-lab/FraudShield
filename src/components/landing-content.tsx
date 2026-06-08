"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { trackDemoView, trackCtaClick } from "@/lib/events";
import { PLANS } from "@/app/pricing/plans";
import { BrandMark } from "@/components/brand-logo";

/* ------------------------------------------------------------------ *
 * FraudShield landing — "Forensic Instrument" design system.
 * Dark cool evidence-lab surface, signal-cyan accent, severity colors
 * (teal/amber/vermilion) reserved strictly for fraud-score state.
 *
 * Shared <LandingContent> consumed by the root page and /v/[variant]
 * route wrappers (scaffold-pages). Those wrappers spread the full
 * Variant object as flat props and own the `visit_landing` mount event,
 * so this component fires only `demo_view` and `cta_click`.
 * ------------------------------------------------------------------ */

export type LandingContentProps = {
  slug?: string;
  headline: string;
  subheadline: string;
  cta: string;
  pain_points: string[];
  promise: string;
  proof: string;
  urgency: string;
  // Tolerate the extra Variant fields the wrappers spread (pricing_*, isDefault).
  pricing_amount?: number;
  pricing_model?: string;
  isDefault?: boolean;
};

/* ----------------------------- motion utils ----------------------------- */

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

/**
 * BlurFade — scroll-reveal that is ADDITIVE: content stays visible (no
 * opacity:0 initial state). Animation layers blur + translateY on top of
 * already-rendered content, gated behind prefers-reduced-motion.
 */
function BlurFade({
  children,
  delay = 0,
  yOffset = 16,
  className,
  as: Tag = "div",
}: {
  children: React.ReactNode;
  delay?: number;
  yOffset?: number;
  className?: string;
  as?: "div" | "section" | "li" | "span";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const el = ref.current;
    if (!el) {
      setShown(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        // Above-the-fold elements report intersecting on first callback —
        // reveal them immediately (Quality Invariant 3).
        if (entries[0]?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    // Safety reveal: if the observer never fires for this element (fast
    // programmatic scroll, full-page snapshot, print/SEO render, observer
    // edge cases), content must still become visible. The reveal is purely
    // additive — it can only turn content ON, never off (Quality Invariant 3,
    // Self-Check dimension 6: "animations are additive, never subtractive").
    //
    // 250ms covers Playwright fullPage snapshots and crawler renders without
    // hiding the reveal animation during normal scroll (IO fires <50ms when
    // an element actually enters the viewport, so the timer is preempted).
    const safety = window.setTimeout(() => setShown(true), 250);
    return () => {
      io.disconnect();
      window.clearTimeout(safety);
    };
  }, [reduced]);

  const Comp = Tag as React.ElementType;
  return (
    <Comp
      ref={ref as React.Ref<HTMLElement>}
      className={className}
      style={
        reduced
          ? undefined
          : {
              transition:
                "opacity 0.62s cubic-bezier(0.22,1,0.36,1), transform 0.62s cubic-bezier(0.22,1,0.36,1), filter 0.62s cubic-bezier(0.22,1,0.36,1)",
              transitionDelay: `${delay}s`,
              opacity: shown ? 1 : 0.001,
              transform: shown ? "translateY(0)" : `translateY(${yOffset}px)`,
              filter: shown ? "blur(0px)" : "blur(8px)",
              willChange: "opacity, transform, filter",
            }
      }
    >
      {children}
    </Comp>
  );
}

/**
 * NumberTicker — counts up to `value` when scrolled into view. Content is
 * visible before animation (renders the target value under reduced motion).
 */
function NumberTicker({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  durationMs = 1500,
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  durationMs?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [display, setDisplay] = useState(0);
  const reduced = usePrefersReducedMotion();
  const started = useRef(false);

  useEffect(() => {
    if (reduced || typeof IntersectionObserver === "undefined") {
      setDisplay(value);
      return;
    }
    const el = ref.current;
    if (!el) {
      setDisplay(value);
      return;
    }
    const animate = () => {
      if (started.current) return;
      started.current = true;
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / durationMs);
        // ease-out cubic — instrument settle
        const eased = 1 - Math.pow(1 - t, 3);
        setDisplay(value * eased);
        if (t < 1) requestAnimationFrame(tick);
        else setDisplay(value);
      };
      requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !started.current) {
        animate();
        io.disconnect();
      }
    });
    io.observe(el);
    // Safety: if the observer never fires (full-page snapshot, fast scroll),
    // still count up so the figure never sticks at a misleading 0
    // (e.g. "1 in 0"). Additive — only advances toward the real value.
    // 250ms covers Playwright fullPage snapshots and SEO/crawler renders;
    // IO fires <50ms when an element actually enters the viewport, so the
    // timer is preempted during normal scroll.
    const safety = window.setTimeout(() => {
      animate();
      io.disconnect();
    }, 250);
    return () => {
      io.disconnect();
      window.clearTimeout(safety);
    };
  }, [value, durationMs, reduced]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {display.toLocaleString("en-US", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}

/* ------------------------- forensic texture layers ------------------------- */

function ForensicGrid({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
    >
      <defs>
        <pattern
          id="fs-grid"
          width="44"
          height="44"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M44 0H0V44"
            fill="none"
            stroke="oklch(0.74 0.130 213)"
            strokeOpacity="0.06"
            strokeWidth="1"
          />
        </pattern>
        <radialGradient id="fs-grid-fade" cx="50%" cy="0%" r="80%">
          <stop offset="0%" stopColor="white" stopOpacity="0.9" />
          <stop offset="70%" stopColor="white" stopOpacity="0.15" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <mask id="fs-grid-mask">
          <rect width="100%" height="100%" fill="url(#fs-grid-fade)" />
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        fill="url(#fs-grid)"
        mask="url(#fs-grid-mask)"
      />
    </svg>
  );
}

/* SVG noise overlay (opacity 0.03–0.05) for depth on dark surfaces. */
function NoiseOverlay() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.04] mix-blend-overlay"
    >
      <filter id="fs-noise">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.85"
          numOctaves="2"
          stitchTiles="stitch"
        />
      </filter>
      <rect width="100%" height="100%" filter="url(#fs-noise)" />
    </svg>
  );
}

/* logo mark — now sourced from the shared <BrandMark> in
 * src/components/brand-logo.tsx so the global NavBar, landing header/footer,
 * and auth shell all render the identical shield (post-launch bug #2). */

/* ------------------------- signature scan demo ------------------------- */

type DemoPhase = "idle" | "scanning" | "done";

type SignalRow = {
  code: string;
  label: string;
  detail: string;
  weight: number;
  severity: "fraud" | "suspect" | "clear";
  revealAt: number; // ms into the sweep
};

const DEMO_SIGNALS: SignalRow[] = [
  {
    code: "META.PRODUCER",
    label: "Editing tool fingerprint",
    detail: "Producer = “Photoshop 25.x” on a payroll PDF",
    weight: 38,
    severity: "fraud",
    revealAt: 420,
  },
  {
    code: "META.TIMELINE",
    label: "Timestamp anomaly",
    detail: "Modified 4s after creation — re-saved, not issued",
    weight: 21,
    severity: "fraud",
    revealAt: 980,
  },
  {
    code: "XDOC.FONT",
    label: "Cross-document mismatch",
    detail: "Net-pay font differs from employer template",
    weight: 16,
    severity: "suspect",
    revealAt: 1500,
  },
  {
    code: "TPL.MATCH",
    label: "Known-fraud template hit",
    detail: "92% match to a circulated pay-stub generator",
    weight: 12,
    severity: "fraud",
    revealAt: 2000,
  },
];

const FINAL_SCORE = 87; // sums into the "fraud" band

function severityToken(sev: "fraud" | "suspect" | "clear") {
  return sev === "fraud"
    ? "var(--fraud)"
    : sev === "suspect"
      ? "var(--suspect)"
      : "var(--clear)";
}

function scoreBand(score: number): { label: string; sev: "fraud" | "suspect" | "clear" } {
  if (score >= 67) return { label: "Forged — do not approve", sev: "fraud" };
  if (score >= 34) return { label: "Suspect — manual review", sev: "suspect" };
  return { label: "Clear — authentic", sev: "clear" };
}

function ScanDemo({ onEngage }: { onEngage: () => void }) {
  const reduced = usePrefersReducedMotion();
  const [phase, setPhase] = useState<DemoPhase>("idle");
  const [beam, setBeam] = useState(0); // 0..1 sweep position
  const [revealed, setRevealed] = useState<number>(0); // count of signals shown
  const [score, setScore] = useState(0);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const run = useCallback(() => {
    onEngage();
    clearTimers();
    setRevealed(0);
    setScore(0);

    if (reduced) {
      // No motion: jump straight to the resolved forensic result.
      setPhase("done");
      setBeam(1);
      setRevealed(DEMO_SIGNALS.length);
      setScore(FINAL_SCORE);
      return;
    }

    setPhase("scanning");
    setBeam(0);
    // beam sweep top→bottom
    const sweepStart = performance.now();
    const sweepMs = 2300;
    const sweep = (now: number) => {
      const t = Math.min(1, (now - sweepStart) / sweepMs);
      setBeam(t);
      if (t < 1) timers.current.push(window.requestAnimationFrame(sweep) as unknown as number);
    };
    timers.current.push(window.requestAnimationFrame(sweep) as unknown as number);

    // staggered signal reveals as the beam passes
    DEMO_SIGNALS.forEach((sig, i) => {
      timers.current.push(
        window.setTimeout(() => setRevealed((r) => Math.max(r, i + 1)), sig.revealAt)
      );
    });

    // lock-in: gauge fill + score count-up
    timers.current.push(
      window.setTimeout(() => {
        setPhase("done");
        const start = performance.now();
        const dur = 900;
        const count = (now: number) => {
          const t = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - t, 3);
          setScore(Math.round(FINAL_SCORE * eased));
          if (t < 1)
            timers.current.push(window.requestAnimationFrame(count) as unknown as number);
          else setScore(FINAL_SCORE);
        };
        timers.current.push(window.requestAnimationFrame(count) as unknown as number);
      }, sweepMs + 120)
    );
  }, [onEngage, reduced, clearTimers]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const band = scoreBand(phase === "done" ? FINAL_SCORE : score);
  const gaugePct = phase === "idle" ? 0 : score / 100;
  // circular gauge geometry
  const R = 52;
  const C = 2 * Math.PI * R;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      {/* Document under the scanner */}
      <div
        className="group/doc relative overflow-hidden rounded-[var(--radius-lg)] bg-[oklch(0.16_0.02_252)] p-5 ring-1 ring-[oklch(0.92_0.02_220_/_14%)]"
        style={{ boxShadow: "var(--shadow-signal-glow)" }}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-[oklch(0.84_0.014_244)]">
            sample · paystub_03.pdf
          </span>
          <span className="font-mono text-[11px] text-[oklch(0.84_0.014_244)]">
            forensic preview
          </span>
        </div>

        {/* document mockup — believable pay-stub built from tokens only */}
        <div className="relative aspect-[5/6] w-full overflow-hidden rounded-[var(--radius-md)] bg-[oklch(0.965_0.006_240)] ring-1 ring-[oklch(0.92_0.02_220_/_18%)]">
          <div className="flex h-full flex-col gap-3 p-5 text-[oklch(0.20_0.02_252)]">
            {/* employer header */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-heading text-[13px] font-bold leading-tight tracking-[-0.2px] text-[oklch(0.20_0.02_252)]">
                  Acme Logistics Inc.
                </p>
                <p className="font-mono text-[9px] leading-tight text-[oklch(0.45_0.02_252)]">
                  482 Industrial Way · Reno, NV 89502
                </p>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-[oklch(0.50_0.02_252)]">
                Pay stub
              </span>
            </div>

            <div
              aria-hidden
              className="h-px w-full bg-[oklch(0.86_0.012_248)]"
            />

            {/* employee + period */}
            <div className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-sans text-[11px] font-medium text-[oklch(0.30_0.02_252)]">
                  Jordan A. Mitchell
                </span>
                <span className="font-mono text-[9px] text-[oklch(0.45_0.02_252)]">
                  ID 04827
                </span>
              </div>
              <p className="font-mono text-[9px] text-[oklch(0.50_0.02_252)]">
                Pay period: March 1 &ndash; March 15, 2026
              </p>
            </div>

            <div
              aria-hidden
              className="h-px w-full bg-[oklch(0.86_0.012_248)]"
            />

            {/* line items */}
            <ul className="flex flex-col">
              {[
                { label: "Gross pay", amount: "$2,640.00" },
                { label: "Federal tax", amount: "$316.80" },
                { label: "State tax", amount: "$92.40" },
                { label: "FICA", amount: "$201.96" },
              ].map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between border-b border-[oklch(0.90_0.012_248)] py-1.5 last:border-b-0"
                >
                  <span className="font-sans text-[11px] text-[oklch(0.32_0.02_252)]">
                    {row.label}
                  </span>
                  <span className="font-mono text-[11px] tabular-nums text-[oklch(0.28_0.02_252)]">
                    {row.amount}
                  </span>
                </li>
              ))}
            </ul>

            <div
              aria-hidden
              className="h-px w-full bg-[oklch(0.86_0.012_248)]"
            />

            {/* net pay — the line a fraudster would alter */}
            <div
              className="mt-auto flex items-center justify-between rounded-[6px] px-3 py-2.5"
              style={{
                background: "oklch(0.74 0.130 213 / 0.12)",
                boxShadow: "inset 2px 0 0 0 var(--signal)",
              }}
            >
              <span className="font-heading text-[12px] font-bold uppercase tracking-[0.10em] text-[oklch(0.20_0.02_252)]">
                Net pay
              </span>
              <span
                className="font-mono text-[15px] font-semibold tabular-nums"
                style={{ color: "oklch(0.42 0.130 213)" }}
              >
                $2,028.84
              </span>
            </div>
          </div>

          {/* scan beam */}
          {phase !== "idle" && (
            <div
              aria-hidden
              className="absolute inset-x-0 h-16"
              style={{
                top: `calc(${beam * 100}% - 32px)`,
                background:
                  "linear-gradient(to bottom, transparent, oklch(0.74 0.130 213 / 0.0) 8%, oklch(0.74 0.130 213 / 0.28) 50%, transparent)",
                opacity: phase === "scanning" ? 1 : 0,
                transition: "opacity 0.4s ease",
              }}
            >
              <div
                className="absolute inset-x-0 top-1/2 h-px"
                style={{
                  background: "oklch(0.82 0.14 210)",
                  boxShadow: "0 0 12px 2px oklch(0.74 0.130 213 / 0.6)",
                }}
              />
            </div>
          )}

          {/* signal markers dropped on the doc as beam passes */}
          {[18, 41, 63, 80].map((topPct, i) => (
            <div
              key={i}
              aria-hidden
              className="absolute right-3"
              style={{
                top: `${topPct}%`,
                opacity: revealed > i ? 1 : 0,
                transform: revealed > i ? "scale(1)" : "scale(0.6)",
                transition:
                  "opacity 0.3s cubic-bezier(0.22,1,0.36,1), transform 0.3s cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              <span
                className="flex h-5 items-center gap-1 rounded-full px-2 font-mono text-[9px] font-medium"
                style={{
                  background: "oklch(0.16 0.02 252)",
                  color: severityToken(DEMO_SIGNALS[i].severity),
                  boxShadow: `0 0 0 1px ${severityToken(DEMO_SIGNALS[i].severity)}`,
                }}
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: severityToken(DEMO_SIGNALS[i].severity) }}
                />
                {DEMO_SIGNALS[i].code}
              </span>
            </div>
          ))}
        </div>

        {/* run control */}
        <button
          type="button"
          onClick={run}
          aria-label={
            phase === "idle"
              ? "Run the live forensic sample scan"
              : "Re-run the live forensic sample scan"
          }
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-[var(--radius-pill)] bg-primary py-2.5 font-sans text-sm font-semibold text-primary-foreground transition-[transform,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px hover:opacity-95"
          style={{ boxShadow: "var(--shadow-signal-glow)" }}
        >
          {phase === "idle"
            ? "Run the sample scan"
            : phase === "scanning"
              ? "Analyzing…"
              : "Re-run the scan"}
        </button>
      </div>

      {/* Result panel: gauge + per-signal breakdown */}
      <div className="relative flex flex-col rounded-[var(--radius-lg)] bg-[oklch(0.218_0.024_252)] p-6 ring-1 ring-[oklch(0.92_0.02_220_/_14%)]">
        <div className="flex items-center gap-5">
          {/* circular fraud-score gauge */}
          <div className="relative h-[128px] w-[128px] shrink-0">
            <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
              <circle
                cx="64"
                cy="64"
                r={R}
                fill="none"
                stroke="oklch(0.92 0.02 220 / 12%)"
                strokeWidth="9"
              />
              <circle
                cx="64"
                cy="64"
                r={R}
                fill="none"
                stroke={severityToken(band.sev)}
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={C}
                strokeDashoffset={C * (1 - gaugePct)}
                style={{
                  transition: reduced
                    ? "none"
                    : "stroke-dashoffset 0.2s linear, stroke 0.3s ease",
                  filter: `drop-shadow(0 0 6px ${severityToken(band.sev)})`,
                }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span
                className="font-mono text-[34px] font-medium leading-none tabular-nums"
                style={{ color: phase === "idle" ? "oklch(0.84 0.014 244)" : severityToken(band.sev) }}
              >
                {phase === "idle" ? "--" : score}
              </span>
              <span className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-[oklch(0.84_0.014_244)]">
                fraud score
              </span>
            </div>
          </div>

          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[oklch(0.84_0.014_244)]">
              verdict
            </p>
            <p
              className="mt-1 font-heading text-lg font-semibold leading-tight"
              style={{ color: phase === "idle" ? "oklch(0.955 0.006 240)" : severityToken(band.sev) }}
            >
              {phase === "idle" ? "Awaiting scan" : band.label}
            </p>
            <p className="mt-1.5 font-sans text-[13px] leading-snug text-[oklch(0.88_0.012_244)]">
              {phase === "idle"
                ? "Press “Run the sample scan” to watch the forensic sweep."
                : "Score is the weighted sum of every signal below — never a bare number."}
            </p>
          </div>
        </div>

        <div
          aria-hidden
          className="my-5 h-px w-full"
          style={{ background: "oklch(0.92 0.02 220 / 12%)" }}
        />

        {/* per-signal breakdown — the explainability IS the product */}
        <ul className="flex flex-col gap-2.5">
          {DEMO_SIGNALS.map((sig, i) => {
            const on = revealed > i;
            return (
              <li
                key={sig.code}
                className="flex items-start gap-3 rounded-[var(--radius-md)] px-3 py-2.5"
                style={{
                  background: on ? "oklch(0.16 0.02 252)" : "oklch(0.16 0.02 252 / 40%)",
                  boxShadow: on ? `inset 2px 0 0 0 ${severityToken(sig.severity)}` : "none",
                  opacity: on ? 1 : 0.35,
                  transform: on ? "translateX(0)" : "translateX(-4px)",
                  transition:
                    "opacity 0.35s cubic-bezier(0.22,1,0.36,1), transform 0.35s cubic-bezier(0.22,1,0.36,1), box-shadow 0.35s ease",
                }}
              >
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: severityToken(sig.severity) }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-sans text-[13px] font-semibold text-[oklch(0.955_0.006_240)]">
                      {sig.label}
                    </span>
                    <span
                      className="font-mono text-[11px] font-medium tabular-nums"
                      style={{ color: severityToken(sig.severity) }}
                    >
                      +{sig.weight}
                    </span>
                  </span>
                  <span className="mt-0.5 block font-mono text-[11px] leading-snug text-[oklch(0.84_0.014_244)]">
                    {sig.code} · {sig.detail}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------ stat band ------------------------------ */

const STATS = [
  {
    value: 5,
    suffix: "×",
    prefix: "~",
    label: "Rise in AI document fraud across 2025",
    foot: "Apr–Dec, Inscribe 2026 report",
  },
  {
    value: 16,
    prefix: "1 in ",
    label: "Documents now flagged for review",
    foot: "≈6% flag rate, industry-wide",
  },
  {
    value: 500,
    suffix: "%",
    prefix: "+",
    label: "Surge in fake pay stubs",
    foot: "Frank on Fraud, 2025",
  },
];

/* ----------------------------- feature cards ----------------------------- */

const FEATURES = [
  {
    img: "/images/feature-1.webp",
    alt: "Conceptual isometric illustration of metadata forensics: a document peeling into stacked translucent file-property layers with a glowing fingerprint and signal-cyan inspection lines on deep cool-ink",
    tag: "01 · metadata forensics",
    title: "Read what the eye can’t",
    body: "We crack open the file itself — producer tool, creation-vs-modification timestamps, missing edit history — the fingerprints a polished fake leaves behind.",
  },
  {
    img: "/images/feature-2.webp",
    alt: "Conceptual isometric illustration of cross-document checks: two financial documents connected by signal-cyan verification lines with match and mismatch node markers on deep cool-ink",
    tag: "02 · cross-document checks",
    title: "Catch the story that doesn’t add up",
    body: "Fonts, totals, and layouts are compared across documents and against employer templates, so a number that was quietly retyped lights up instantly.",
  },
  {
    img: "/images/feature-3.webp",
    alt: "Conceptual isometric illustration of known-fraud-template matching: a clean document linked by a signal-cyan match beam to one highlighted cell in a grid of dimmed known-fraud-template signatures on deep cool-ink",
    tag: "03 · known-fraud templates",
    title: "Match it to the kits fraudsters buy",
    body: "Every scan is checked against a signature database of circulating $10 generator templates — and the database gets sharper with every document we see.",
  },
];

const SEGMENTS = [
  "Independent landlords",
  "Small & regional lenders",
  "MCA brokers",
  "Gig-platform trust teams",
  "SMB finance & AP",
  "Property managers",
];

/* --------------------------- pricing preview --------------------------- */

/**
 * Compact two-card pricing surface for the landing page. Pulls from the
 * shared PLANS constant in src/app/pricing/plans.ts — never duplicate the
 * prices. The Pro CTA routes to /pricing (the full upgrade flow); Free
 * routes to /signup. Listed below the cards is a link to the full plan
 * comparison.
 */
function PricingPreviewSection({ onCtaClick }: { onCtaClick: () => void }) {
  return (
    <section
      id="pricing"
      className="relative overflow-hidden border-y border-[oklch(0.92_0.02_220_/_10%)] bg-[oklch(0.155_0.022_252)] py-24"
    >
      <div className="mx-auto max-w-5xl px-6">
        <div className="mb-12 max-w-2xl">
          <BlurFade>
            <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-[oklch(0.82_0.10_210)]">
              Pricing
            </span>
          </BlurFade>
          <BlurFade delay={0.07}>
            <h2 className="mt-3 font-heading text-[clamp(2rem,4vw,3rem)] font-extrabold leading-[1.08] tracking-[-1.5px] text-foreground">
              Start free. Upgrade when fraud stops being a guess.
            </h2>
          </BlurFade>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          {PLANS.map((plan, i) => {
            const isPro = plan.id === "pro";
            const href = isPro ? "/pricing" : "/signup";
            const ctaLabel = isPro ? "Choose Pro" : "Start free";
            // Compact, landing-tier feature blurbs — distinct from the full
            // pricing page list. Source of truth for prices is still PLANS.
            const blurb = isPro
              ? [
                  "Unlimited document scans",
                  "Priority support",
                  "API access (coming soon)",
                ]
              : [
                  `${PLANS[0].features[0].label}`,
                  "Per-signal breakdown",
                  "Pay stubs · bank statements · invoices",
                ];
            return (
              <BlurFade key={plan.id} delay={0.14 + i * 0.08}>
                <article
                  className={cn(
                    "relative flex h-full flex-col rounded-[var(--radius-lg)] p-7 ring-1 transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5",
                    isPro
                      ? "bg-[oklch(0.218_0.024_252)] ring-[oklch(0.74_0.130_213_/_45%)]"
                      : "bg-[oklch(0.185_0.022_252)] ring-[oklch(0.92_0.02_220_/_14%)]",
                  )}
                  style={
                    isPro
                      ? { boxShadow: "var(--shadow-signal-glow)" }
                      : undefined
                  }
                >
                  {isPro && (
                    <span
                      className="absolute -top-3 right-6 rounded-[var(--radius-pill)] px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-primary-foreground"
                      style={{ background: "oklch(0.74 0.130 213)" }}
                    >
                      Most popular
                    </span>
                  )}
                  <header>
                    <h3 className="font-heading text-[1.5rem] font-bold tracking-[-0.5px] text-foreground">
                      {plan.name}
                    </h3>
                    <p className="mt-1.5 font-sans text-[13.5px] leading-snug text-[oklch(0.84_0.012_244)]">
                      {plan.tagline}
                    </p>
                  </header>
                  <div className="mt-5 flex items-baseline gap-1.5">
                    <span className="font-mono text-[2.75rem] font-medium leading-none tabular-nums text-foreground">
                      ${plan.priceMonthly ?? 0}
                    </span>
                    {plan.priceMonthly && plan.priceMonthly > 0 ? (
                      <span className="font-mono text-[12px] text-[oklch(0.82_0.014_244)]">
                        / month
                      </span>
                    ) : (
                      <span className="font-mono text-[12px] text-[oklch(0.82_0.014_244)]">
                        forever
                      </span>
                    )}
                  </div>
                  <ul className="mt-6 flex flex-col gap-2.5">
                    {blurb.map((item) => (
                      <li
                        key={item}
                        className="flex items-start gap-2.5 font-sans text-[14px] leading-snug text-[oklch(0.90_0.01_244)]"
                      >
                        <svg
                          viewBox="0 0 16 16"
                          aria-hidden
                          className="mt-1 h-3.5 w-3.5 shrink-0"
                        >
                          <path
                            d="M3 8.5l3 3 7-7.5"
                            fill="none"
                            stroke="oklch(0.74 0.130 213)"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-7">
                    <Link
                      href={href}
                      onClick={isPro ? undefined : onCtaClick}
                      className={cn(
                        "inline-flex w-full items-center justify-center gap-2 rounded-[var(--radius-pill)] py-2.5 font-sans text-[14px] font-semibold transition-[transform,opacity] duration-150 hover:-translate-y-px hover:opacity-95",
                        isPro
                          ? "bg-primary text-primary-foreground"
                          : "bg-[oklch(0.218_0.024_252)] text-foreground ring-1 ring-[oklch(0.92_0.02_220_/_22%)]",
                      )}
                      style={
                        isPro
                          ? { boxShadow: "var(--shadow-signal-glow)" }
                          : undefined
                      }
                    >
                      {ctaLabel}
                    </Link>
                  </div>
                </article>
              </BlurFade>
            );
          })}
        </div>

        <BlurFade delay={0.32}>
          <p className="mt-8 text-center font-sans text-[13px] text-[oklch(0.82_0.012_244)]">
            <Link
              href="/pricing"
              className="inline-flex items-center gap-1 font-medium text-[oklch(0.82_0.10_210)] transition-colors duration-150 hover:text-foreground"
            >
              See full plan details
              <span aria-hidden>&rarr;</span>
            </Link>
          </p>
        </BlurFade>
      </div>
    </section>
  );
}

/* --------------------------------- page --------------------------------- */

export function LandingContent(props: LandingContentProps) {
  const {
    slug,
    headline,
    subheadline,
    cta,
    pain_points,
    promise,
    proof,
    urgency,
  } = props;
  const variant = { headline, subheadline, cta, pain_points, promise, proof, urgency };
  const demoFired = useRef(false);

  // NOTE: `visit_landing` is fired by the route wrappers (page.tsx /
  // variant-landing.tsx) that own the mount. We fire only the engagement
  // events here to avoid double-counting.
  const handleDemoEngage = useCallback(() => {
    if (demoFired.current) return;
    demoFired.current = true;
    trackDemoView({ variant: slug });
  }, [slug]);

  const handleCtaClick = useCallback(() => {
    trackCtaClick({ variant: slug });
  }, [slug]);

  return (
    <div className="dark min-h-screen bg-background font-sans text-foreground [letter-spacing:-0.1px]">
      {/* ============================= NAV ============================= */}
      {/* Sticky header — stays reachable while scrolling long marketing pages
       * (post-launch bug #1). Backdrop blur + translucent ink bg keeps it
       * legible without a hard edge over the hero mesh.
       * The outer wrapper itself is the sticky element; the inner row keeps the
       * existing max-w / padding rhythm of the rest of the landing. */}
      <header className="sticky top-0 z-40 border-b border-border/30 bg-background/75 backdrop-blur-md supports-[backdrop-filter]:bg-background/55">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-4">
        <Link href="/" aria-label="FraudShield home" className="flex items-center gap-2.5">
          <BrandMark size={28} />
          <span className="font-heading text-[17px] font-bold tracking-[-0.5px] text-foreground">
            FraudShield
          </span>
        </Link>
        <nav className="flex items-center gap-3 sm:gap-5">
          <a
            href="#pricing"
            className="font-sans text-[13px] font-medium text-[oklch(0.82_0.012_244)] transition-colors duration-150 hover:text-foreground"
          >
            Pricing
          </a>
          <Link
            href="/login"
            className="font-sans text-[13px] font-medium text-[oklch(0.82_0.012_244)] transition-colors duration-150 hover:text-foreground"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            onClick={handleCtaClick}
            className="rounded-[var(--radius-pill)] bg-primary px-4 py-2 font-sans text-[13px] font-semibold whitespace-nowrap text-primary-foreground transition-[transform,opacity] duration-150 hover:-translate-y-px hover:opacity-95"
          >
            {/* Concise nav CTA on small screens; full variant CTA from md up */}
            <span className="md:hidden">Scan free</span>
            <span className="hidden md:inline">{variant.cta}</span>
          </Link>
        </nav>
        </div>
      </header>

      {/* ============================= HERO ============================= */}
      <section className="relative overflow-hidden">
        {/* z-layer 1: mesh + grid + noise texture */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 90% at 18% 0%, oklch(0.74 0.130 213 / 0.16), transparent 55%), radial-gradient(80% 70% at 92% 12%, oklch(0.66 0.225 27 / 0.05), transparent 60%)",
          }}
        />
        <ForensicGrid />
        <NoiseOverlay />

        <div className="relative z-10 mx-auto grid max-w-7xl items-center gap-10 px-6 pb-20 pt-10 lg:grid-cols-[1.04fr_0.96fr] lg:pb-28 lg:pt-16">
          {/* headline overlay — upper-left */}
          <div className="max-w-xl">
            <BlurFade delay={0}>
              <span className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-[oklch(0.82_0.10_210)] ring-1 ring-[oklch(0.74_0.130_213_/_30%)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[oklch(0.74_0.130_213)] [box-shadow:0_0_8px_oklch(0.74_0.130_213)]" />
                Forensic document fraud detection
              </span>
            </BlurFade>

            <BlurFade delay={0.07}>
              <h1 className="mt-5 font-heading text-[clamp(3rem,6.6vw,5.25rem)] font-extrabold leading-[1.04] tracking-[-2px] text-foreground">
                {variant.headline}
              </h1>
            </BlurFade>

            <BlurFade delay={0.14}>
              <p className="mt-5 max-w-lg font-sans text-[clamp(1rem,1.4vw,1.1875rem)] leading-[1.55] text-[oklch(0.82_0.012_244)]">
                {variant.subheadline}
              </p>
            </BlurFade>

            <BlurFade delay={0.21}>
              <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center">
                <Link
                  href="/signup"
                  onClick={handleCtaClick}
                  className="group/cta inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-primary px-7 py-3.5 font-sans text-[15px] font-semibold text-primary-foreground transition-[transform,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:opacity-95"
                  style={{ boxShadow: "var(--shadow-signal-glow)" }}
                >
                  Scan your first document free
                  <svg viewBox="0 0 16 16" className="h-4 w-4 transition-transform duration-150 group-hover/cta:translate-x-0.5" aria-hidden>
                    <path d="M3 8h9M8 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Link>
                <a
                  href="#live-demo"
                  className="inline-flex items-center gap-2 rounded-[var(--radius-md)] px-4 py-3 font-sans text-[14px] font-medium text-[oklch(0.82_0.012_244)] ring-1 ring-[oklch(0.92_0.02_220_/_16%)] transition-colors duration-150 hover:text-foreground hover:ring-[oklch(0.74_0.130_213_/_45%)]"
                >
                  Watch a live scan
                </a>
              </div>
            </BlurFade>

            <BlurFade delay={0.28}>
              <p className="mt-5 font-mono text-[12px] text-[oklch(0.84_0.014_244)]">
                {variant.urgency}
              </p>
            </BlurFade>
          </div>

          {/* z-layer 3: hero image + floating glass score chip */}
          <BlurFade delay={0.16} className="relative">
            <div
              className="relative overflow-hidden rounded-[var(--radius-xl)] ring-1 ring-[oklch(0.92_0.02_220_/_14%)]"
              style={{ boxShadow: "var(--shadow-signal-glow)" }}
            >
              <Image
                src="/images/hero.webp"
                alt="A financial document fanning into translucent forensic metadata layers with signal-cyan analysis lines and a glowing fraud-score gauge on a deep cool-ink background"
                width={1920}
                height={1088}
                priority
                sizes="(max-width: 1024px) 100vw, 46vw"
                className="h-auto w-full"
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  background:
                    "linear-gradient(to top, oklch(0.175 0.022 252 / 0.55), transparent 45%)",
                }}
              />
            </div>

            {/* floating glass verdict chip */}
            <div
              className="absolute -bottom-4 left-4 flex items-center gap-3 rounded-[var(--radius-lg)] px-4 py-3 backdrop-blur-md sm:left-6"
              style={{
                background: "oklch(0.218 0.024 252 / 0.72)",
                boxShadow:
                  "0 0 0 1px oklch(0.66 0.225 27 / 0.45), 0 0 24px oklch(0.66 0.225 27 / 0.2)",
              }}
            >
              <span className="font-mono text-[28px] font-medium leading-none tabular-nums text-[var(--fraud)]">
                87
              </span>
              <span className="leading-tight">
                <span className="block font-sans text-[13px] font-semibold text-[var(--fraud)]">
                  Forged — do not approve
                </span>
                <span className="block font-mono text-[11px] text-[oklch(0.84_0.014_244)]">
                  4 signals · scored in 1.8s
                </span>
              </span>
            </div>
          </BlurFade>
        </div>
      </section>

      {/* =========================== STAT BAND =========================== */}
      <section className="relative border-y border-[oklch(0.92_0.02_220_/_10%)] bg-[oklch(0.155_0.022_252)] py-16">
        <div className="mx-auto max-w-7xl px-6">
          <BlurFade>
            <p className="mb-10 max-w-2xl font-mono text-[12px] uppercase tracking-[0.18em] text-[oklch(0.84_0.014_244)]">
              The threat is the proof — the numbers below are why this exists
            </p>
          </BlurFade>
          <div className="grid gap-px overflow-hidden rounded-[var(--radius-lg)] ring-1 ring-[oklch(0.92_0.02_220_/_10%)] sm:grid-cols-3">
            {STATS.map((s, i) => (
              <BlurFade
                key={s.label}
                delay={i * 0.08}
                className="bg-[oklch(0.185_0.022_252)] p-7"
              >
                <div className="flex items-baseline font-heading text-[clamp(2.75rem,5vw,4rem)] font-extrabold leading-none tracking-[-2px] text-foreground">
                  <NumberTicker
                    value={s.value}
                    prefix={s.prefix}
                    suffix={s.suffix}
                    className="tabular-nums"
                  />
                </div>
                <p className="mt-3 font-sans text-[15px] font-medium leading-snug text-[oklch(0.88_0.01_244)]">
                  {s.label}
                </p>
                <p className="mt-1.5 font-mono text-[11px] text-[oklch(0.82_0.014_244)]">
                  {s.foot}
                </p>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ LIVE DEMO ============================ */}
      <section id="live-demo" className="relative overflow-hidden py-24">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(90% 60% at 80% 30%, oklch(0.74 0.130 213 / 0.08), transparent 60%)",
          }}
        />
        <div className="relative z-10 mx-auto max-w-6xl px-6">
          <div className="mb-12 max-w-2xl">
            <BlurFade>
              <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-[oklch(0.82_0.10_210)]">
                Live sample scan
              </span>
            </BlurFade>
            <BlurFade delay={0.07}>
              <h2 className="mt-3 font-heading text-[clamp(2rem,4vw,3rem)] font-extrabold leading-[1.08] tracking-[-1.5px] text-foreground">
                Watch a fake pay stub fall apart
              </h2>
            </BlurFade>
            <BlurFade delay={0.14}>
              <p className="mt-4 font-sans text-[17px] leading-[1.55] text-[oklch(0.82_0.012_244)]">
                {variant.proof} — run the real forensic sweep on a sample document. No signup, no upload. This is exactly what you see after every scan.
              </p>
            </BlurFade>
          </div>
          <BlurFade delay={0.18}>
            <ScanDemo onEngage={handleDemoEngage} />
          </BlurFade>
        </div>
      </section>

      {/* ============================ PAIN POINTS ============================ */}
      <section className="relative border-y border-[oklch(0.92_0.02_220_/_10%)] bg-[oklch(0.155_0.022_252)] py-20">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid gap-10 lg:grid-cols-[0.85fr_1.15fr]">
            <BlurFade>
              <h2 className="font-heading text-[clamp(1.875rem,3.6vw,2.75rem)] font-extrabold leading-[1.1] tracking-[-1.5px] text-foreground">
                {variant.promise}
              </h2>
            </BlurFade>
            <ul className="flex flex-col gap-px overflow-hidden rounded-[var(--radius-lg)] ring-1 ring-[oklch(0.92_0.02_220_/_10%)]">
              {variant.pain_points.map((pt, i) => (
                <BlurFade
                  key={pt}
                  as="li"
                  delay={i * 0.08}
                  className="flex items-start gap-4 bg-[oklch(0.185_0.022_252)] px-6 py-5"
                >
                  <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-1 ring-[oklch(0.66_0.225_27_/_45%)]">
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden>
                      <path d="M8 1.5 1 13.5h14L8 1.5Z" fill="none" stroke="var(--fraud)" strokeWidth="1.4" strokeLinejoin="round" />
                      <path d="M8 6v3.4M8 11.4v0.1" stroke="var(--fraud)" strokeWidth="1.4" strokeLinecap="round" />
                    </svg>
                  </span>
                  <span className="font-sans text-[16px] leading-[1.5] text-[oklch(0.9_0.01_244)]">
                    {pt}
                  </span>
                </BlurFade>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ============================ FEATURES ============================ */}
      <section className="relative py-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mb-14 max-w-2xl">
            <BlurFade>
              <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-[oklch(0.82_0.10_210)]">
                Three forensic engines · one pass
              </span>
            </BlurFade>
            <BlurFade delay={0.07}>
              <h2 className="mt-3 font-heading text-[clamp(2rem,4vw,3rem)] font-extrabold leading-[1.08] tracking-[-1.5px] text-foreground">
                The tooling big banks use, finally yours
              </h2>
            </BlurFade>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {FEATURES.map((f, i) => (
              <BlurFade
                key={f.title}
                delay={i * 0.1}
                className={cn(
                  // asymmetric: first card spans wider on large screens
                  i === 0 && "lg:col-span-1"
                )}
              >
                <article className="group/card relative flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] bg-[oklch(0.218_0.024_252)] ring-1 ring-[oklch(0.92_0.02_220_/_12%)] transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:ring-[oklch(0.74_0.130_213_/_45%)] hover:[box-shadow:0_0_0_1px_oklch(0.74_0.130_213_/_30%),0_0_28px_oklch(0.74_0.130_213_/_14%)]">
                  <div className="relative aspect-[16/12] w-full overflow-hidden bg-[oklch(0.16_0.02_252)]">
                    <Image
                      src={f.img}
                      alt={f.alt}
                      width={1920}
                      height={1493}
                      sizes="(max-width: 1024px) 100vw, 30vw"
                      className="h-full w-full object-cover transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/card:scale-[1.03]"
                    />
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0"
                      style={{
                        background:
                          "linear-gradient(to top, oklch(0.218 0.024 252 / 0.9), transparent 40%)",
                      }}
                    />
                  </div>
                  <div className="flex flex-1 flex-col p-6">
                    <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[oklch(0.82_0.10_210)]">
                      {f.tag}
                    </span>
                    <h3 className="mt-2.5 font-heading text-[1.375rem] font-bold leading-[1.12] tracking-[-0.5px] text-foreground">
                      {f.title}
                    </h3>
                    <p className="mt-2.5 font-sans text-[14.5px] leading-[1.55] text-[oklch(0.88_0.012_244)]">
                      {f.body}
                    </p>
                  </div>
                </article>
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ========================== SEGMENT STRIP ========================== */}
      <section className="relative overflow-hidden border-y border-[oklch(0.92_0.02_220_/_10%)] bg-[oklch(0.155_0.022_252)] py-10">
        <div className="mx-auto max-w-7xl px-6">
          <BlurFade>
            <p className="mb-6 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[oklch(0.82_0.014_244)]">
              Built for
            </p>
          </BlurFade>
          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-4 sm:gap-x-6">
            {SEGMENTS.map((seg, i) => (
              <BlurFade key={seg} as="span" delay={i * 0.05} className="flex items-center gap-3 sm:gap-6">
                <span className="font-heading text-[15px] font-semibold tracking-[-0.3px] text-[oklch(0.95_0.008_244)] sm:text-[17px]">
                  {seg}
                </span>
                {i < SEGMENTS.length - 1 && (
                  <span aria-hidden className="hidden h-1 w-1 rounded-full bg-[oklch(0.74_0.130_213)] sm:inline-block" />
                )}
              </BlurFade>
            ))}
          </div>
        </div>
      </section>

      {/* ============================ PRICING ============================ */}
      <PricingPreviewSection onCtaClick={handleCtaClick} />

      {/* ============================ FINAL CTA ============================ */}
      <section className="relative overflow-hidden py-28">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(70% 90% at 50% 110%, oklch(0.74 0.130 213 / 0.2), transparent 60%)",
          }}
        />
        <ForensicGrid className="opacity-60" />
        <div className="relative z-10 mx-auto max-w-3xl px-6 text-center">
          <BlurFade>
            <h2 className="font-heading text-[clamp(2.25rem,5vw,3.75rem)] font-extrabold leading-[1.06] tracking-[-2px] text-foreground">
              Stop guessing whether a document is real
            </h2>
          </BlurFade>
          <BlurFade delay={0.08}>
            <p className="mx-auto mt-5 max-w-xl font-sans text-[18px] leading-[1.55] text-[oklch(0.82_0.012_244)]">
              {variant.subheadline}
            </p>
          </BlurFade>
          <BlurFade delay={0.16}>
            <div className="mt-9 flex flex-col items-center gap-4">
              <Link
                href="/signup"
                onClick={handleCtaClick}
                className="group/cta inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-primary px-8 py-4 font-sans text-[16px] font-semibold text-primary-foreground transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:opacity-95"
                style={{ boxShadow: "var(--shadow-signal-glow)" }}
              >
                Scan your first document free
                <svg viewBox="0 0 16 16" className="h-4 w-4 transition-transform duration-150 group-hover/cta:translate-x-0.5" aria-hidden>
                  <path d="M3 8h9M8 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </Link>
              <p className="font-mono text-[12px] text-[oklch(0.84_0.014_244)]">
                No card required · forensic score in seconds · self-serve, no sales call
              </p>
            </div>
          </BlurFade>
        </div>
      </section>

      {/* ============================== FOOTER ============================== */}
      <footer className="relative border-t border-[oklch(0.92_0.02_220_/_10%)]">
        {/* hair-line signal accent — instrument-panel detail */}
        <div
          aria-hidden
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(to right, transparent, oklch(0.74 0.130 213 / 0.45), transparent)",
          }}
        />
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-6 px-6 py-12 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark size={28} />
            <div className="leading-tight">
              <span className="block font-heading text-[16px] font-bold tracking-[-0.5px] text-foreground">
                FraudShield
              </span>
              <span className="block font-mono text-[10px] uppercase tracking-[0.16em] text-[oklch(0.82_0.014_244)]">
                Forensic instrument · v1
              </span>
            </div>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[oklch(0.84_0.014_244)]">
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full bg-[oklch(0.72_0.140_168)] [box-shadow:0_0_8px_oklch(0.72_0.140_168_/_0.65)]"
              />
              Detector online · sample db synced
            </div>
            <p className="font-mono text-[11px] text-[oklch(0.82_0.014_244)]">
              Forensic fraud scores in seconds · built for small operators
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
