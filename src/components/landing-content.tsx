"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { trackCtaClick } from "@/lib/events";
import { PLANS } from "@/app/pricing/plans";
import { BrandMark } from "@/components/brand-logo";
import { FreeScanPanel } from "@/components/free-scan-panel";
import { HEADER_SURFACE } from "@/components/nav-bar";
import { SUPPORT_EMAIL } from "@/lib/billing-copy";

/* ------------------------------------------------------------------ *
 * FraudShield landing — "Forensic Instrument" design system.
 * Dark cool evidence-lab surface, signal-cyan accent, severity colors
 * (teal/amber/vermilion) reserved strictly for fraud-score state.
 *
 * Shared <LandingContent> consumed by the root page and /v/[variant]
 * route wrappers (scaffold-pages). Those wrappers spread the full
 * Variant object as flat props and own the `visit_landing` mount event,
 * so this component fires only `cta_click`. The live-demo section hands
 * the whole interaction to <FreeScanPanel>, which owns its own
 * free_scan_* events — nothing here instruments it.
 * ------------------------------------------------------------------ */

/* Footer link treatment. The severity palette (teal / amber / vermilion) and
   the signal cyan are reserved for fraud-score state, so a footer link cannot
   spend colour to announce that it is a link. It sits at the same muted tone
   as the tagline beside it and earns its affordance from a faint rule; hover
   brightens the text and the rule together. Keyboard focus borrows the
   hairline accent already drawn across the top of the footer. */
const FOOTER_LINK =
  "rounded-[2px] text-[oklch(0.82_0.014_244)] underline decoration-[oklch(0.82_0.014_244_/_35%)] underline-offset-4 transition-colors hover:text-foreground hover:decoration-[oklch(0.74_0.130_213_/_70%)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[oklch(0.74_0.130_213)]";

/** Pads a footer link out to the 24px minimum target size (WCAG 2.5.8).
 *  Separated from FOOTER_LINK so the colour and underline treatment above
 *  stays the one place either is decided. */
const FOOTER_TARGET = "inline-block min-h-6 py-1";

/* ONE TOKEN FOR THE FILLED-CTA ROLE ON THIS PAGE: --signal.
   Every filled call to action here -- the nav CTA, the hero CTA, the Pro
   plan card and the closing CTA -- was bg-primary/text-primary-foreground
   while the free-scan panel beside them in #live-demo uses
   bg-signal/text-signal-foreground. On dark those two tokens are
   oklch(0.72 0.125 215) and oklch(0.74 0.130 213): same role, same pill
   radius, 0.02 apart in lightness and 2 degrees in hue, and the nav CTA is
   co-visible with the panel's button whenever the demo is in frame. Two
   tokens that close together do not read as two colours, they read as one
   colour rendered badly.

   Unified ONTO --signal rather than onto --primary, in that direction for
   three reasons: globals.css declares --signal as "the CTA + key-action
   color, used sparingly", /pricing already fills every plan CTA with it, and
   --primary is graphite in the light palette, so a CTA built on it only
   looks like a CTA while the page is dark. Moving the panel to --primary
   instead would have made this page agree with itself and disagree with
   /pricing and the pricing cards below.

   The "Most popular" pill lost its hand-rolled oklch(0.74 0.130 213) in the
   same pass -- that literal WAS --signal, spelled out, under the wrong
   foreground token. */

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
    alt: "Conceptual isometric illustration of document content review: a financial document with signal-cyan markers on individual figures and rows on deep cool-ink",
    tag: "02 · content review",
    title: "Catch the story that doesn’t add up",
    body: "An AI pass reads the document itself — arithmetic that does not reconcile, dates that contradict each other, a figure set in a different font to the row it sits in.",
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
            // pricing page list. The scan cap is read from PLANS, not restated:
            // it was hardcoded here as "Unlimited" and survived the move to a
            // 200/month cap, so paid traffic landed on a page promising
            // something the pricing page contradicted one click later.
            const blurb = isPro
              ? [
                  plan.features[0].label,
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
                      className="absolute -top-3 right-6 rounded-[var(--radius-pill)] bg-signal px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-signal-foreground"
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
                          ? "bg-signal text-signal-foreground"
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

  // NOTE: `visit_landing` is fired by the route wrappers (page.tsx /
  // variant-landing.tsx) that own the mount, and the free_scan_* events are
  // fired by <FreeScanPanel>. We fire only the CTA click here, so nothing on
  // this page is double-counted.
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
      <header className={HEADER_SURFACE}>
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-6 py-4">
        <Link href="/" aria-label="FraudShield home" className="flex items-center gap-2.5">
          <BrandMark size={30} />
          <span className="font-heading text-xl font-bold tracking-[-0.5px] text-foreground">
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
            className="rounded-[var(--radius-pill)] bg-signal px-4 py-2 font-sans text-[13px] font-semibold whitespace-nowrap text-signal-foreground transition-[transform,opacity] duration-150 hover:-translate-y-px hover:opacity-95"
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
                  className="group/cta inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-signal px-7 py-3.5 font-sans text-[15px] font-semibold text-signal-foreground transition-[transform,box-shadow,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:opacity-95"
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
                  {/* NOT "Watch a live scan". That label is a leftover from
                      the canned animation this section used to hold. #live-demo
                      is now <FreeScanPanel>, which asks the visitor to upload
                      their own document -- so "watch" promises a passive demo
                      and delivers a drop target, and a visitor who came to
                      look leaves rather than scan.

                      "No account" rather than "free" is what distinguishes it
                      from the primary CTA beside it ("Scan your first document
                      free", which goes to /signup); two labels both leading
                      with "free" would read as the same door twice. */}
                  Scan a document — no account
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

            {/* Floating glass band chip.
             *
             * This used to read "87 / Forged — do not approve / 4 signals ·
             * scored in 1.8s" — numbers mirrored off the canned demo's
             * hardcoded signal list and final score. With the demo gone and a
             * real scan under it, every one of those became an invented
             * measurement of a document nobody uploaded: a visitor whose own
             * scan returns 41 and two signals has been told something false
             * before they ever clicked.
             *
             * So the chip stops pretending to be a reading and becomes the
             * scale. 67 is the published top-band threshold (scoreSeverity in
             * lib/fraud/score.ts) and "Likely forged" is the band word the
             * result surface actually prints (scan-result/score-gauge.tsx) —
             * the same words the free panel below shows, so the landing and
             * the verdict no longer use two vocabularies for one band. The
             * geometry, the vermilion, and the glow are untouched: the hero
             * keeps its second focal point, it just no longer makes it up. */}
            <div
              className="absolute -bottom-4 left-4 flex items-center gap-3 rounded-[var(--radius-lg)] px-4 py-3 backdrop-blur-md sm:left-6"
              style={{
                background: "oklch(0.218 0.024 252 / 0.72)",
                boxShadow:
                  "0 0 0 1px oklch(0.66 0.225 27 / 0.45), 0 0 24px oklch(0.66 0.225 27 / 0.2)",
              }}
            >
              <span className="font-mono text-[28px] font-medium leading-none tabular-nums text-[var(--fraud)]">
                67+
              </span>
              <span className="leading-tight">
                <span className="block font-sans text-[13px] font-semibold text-[var(--fraud)]">
                  Likely forged
                </span>
                <span className="block font-mono text-[11px] text-[oklch(0.84_0.014_244)]">
                  Top of three score bands
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
        <div className="relative z-10 mx-auto grid max-w-6xl items-start gap-10 px-6 lg:grid-cols-[0.9fr_1.1fr] lg:gap-14">
          <div className="max-w-xl">
            {/* The eyebrow carries the two constraints instead of naming the
                section. Learning at the file picker that a PDF needs an
                account, or at the response that the day is used up, refuses a
                visitor AFTER they committed to a document. The panel handles
                both refusals correctly; this line is what stops them being
                reached. */}
            <BlurFade>
              <span className="font-mono text-[12px] uppercase tracking-[0.18em] text-[oklch(0.82_0.10_210)]">
                Three free scans a day, images only, no account
              </span>
            </BlurFade>
            <BlurFade delay={0.07}>
              <h2 className="mt-3 font-heading text-[clamp(2rem,4vw,3rem)] font-extrabold leading-[1.08] tracking-[-1.5px] text-foreground">
                Scan your own document
              </h2>
            </BlurFade>
            <BlurFade delay={0.14}>
              {/* OWNS THE PIPELINE CLAIM AND NOTHING ELSE.
                  Two sentences were cut from this paragraph on 2026-11-05.

                  "a free account shows all of them" WAS FALSE, and falsely in
                  the one direction that costs a signup: the authenticated
                  result surface renders the per-signal breakdown only when
                  `isPro` and hands everybody else LockedSignals (the ternary
                  in scan-result-client.tsx). The panel's own teaser had
                  already been corrected to say the breakdown is paid; this
                  line was still selling the opposite promise 300px to its
                  left, so the section contradicted itself and the landing
                  made the bait-and-switch the panel was rewritten to avoid.

                  "The free result shows two of the signals" was ALSO a
                  duplicate: IDLE_PROMISE states the same count inside the
                  panel, in the same viewport. The panel owns what you get
                  back. This paragraph owns the one fact the panel cannot
                  state about itself -- that the engine is the paid one. */}
              <p className="mt-4 font-sans text-[17px] leading-[1.55] text-[oklch(0.82_0.012_244)]">
                Whatever you upload goes through the forensic pipeline a paying
                customer gets, scored by the same engine, with nothing staged
                for the landing page. The score that comes back is the real
                one. The findings behind it are where the free scan stops.
              </p>
            </BlurFade>
            <BlurFade delay={0.2}>
              {/* variant.proof, interpolated NOWHERE ELSE in this component.
                  Drop it and the three /v/<slug> pages lose the only thing
                  that distinguishes them here.

                  It gets its own line rather than a clause inside the
                  paragraph because the three values are different
                  grammatical shapes: two are capability fragments, and
                  built-for-small-operators is a positioning sentence that
                  ends by telling you to sign up and scan. That cannot be
                  spliced into a sentence about scanning without an account
                  without contradicting itself. Standing alone, under a rule
                  that marks it as the claim this widget exists to settle,
                  all three read. */}
              <p
                className="mt-6 border-l-2 pl-4 font-sans text-[15px] leading-[1.5] text-[oklch(0.88_0.012_244)]"
                style={{ borderColor: "oklch(0.74 0.130 213 / 55%)" }}
              >
                {variant.proof}
              </p>
            </BlurFade>
          </div>

          {/* NO BlurFade wrapper, unlike every other block on this page.
              This is the one control on the landing, and the panel already
              runs its own four-state choreography (drop well, scanning
              stages, verdict, refusal) which is the single orchestrated
              motion moment in the section. A scroll entrance layered on top
              would be a second motion system fighting the first, and at
              delay 0.18 it would make the drop target the last thing on the
              page to look touchable, on the surface that is paid for per
              click.

              Two columns rather than a full-width card below the heading:
              the panel caps its own prose at 62ch, so stretched across the
              6xl container it reads as an empty slab. At this ratio it lands near 560px, and the asymmetric
              split matches the pain-points section below. */}
          <FreeScanPanel variant={slug} />
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
                className="group/cta inline-flex items-center gap-2 rounded-[var(--radius-pill)] bg-signal px-8 py-4 font-sans text-[16px] font-semibold text-signal-foreground transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-0.5 hover:opacity-95"
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

            {/* The only two interactive elements in the footer, and the only
                legal and contact surface cold ad traffic sees before the
                signup wall. They get their own rows at normal tracking: the
                support address is an unbreakable ~125px token, and the 0.16em
                tracking on the status row above would push it past the
                viewport at 393px. The address comes from billing-copy, so it
                cannot drift away from the one printed on /terms.

                FOOTER_TARGET is why these rows are taller than their 11px
                type: an 11px line box is a ~16px tap target, and this is the
                one place on a phone where someone hunts for the terms before
                they hand over a card. min-h-6 + vertical padding takes each
                link to the 24px floor (WCAG 2.5.8) without touching the type
                size, the muted tone or the underline — the padding is
                invisible, so the footer still reads as a quiet instrument
                caption rather than a stack of buttons. Vertical only: the
                address is already at the width budget for a 393px viewport. */}
            <nav
              aria-label="Legal and support"
              className="flex flex-col items-start gap-1.5 font-mono text-[11px] sm:items-end"
            >
              <Link href="/terms" className={`${FOOTER_LINK} ${FOOTER_TARGET}`}>
                Terms
              </Link>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className={`${FOOTER_LINK} ${FOOTER_TARGET}`}
              >
                {SUPPORT_EMAIL}
              </a>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
