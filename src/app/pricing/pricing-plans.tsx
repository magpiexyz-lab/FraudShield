"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Minus, Loader2, ShieldAlert, ArrowRight, BellRing } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { trackCheckoutStart, trackPayIntent } from "@/lib/events";
import { getDistinctId } from "@/lib/analytics";
import { readAttribution } from "@/lib/attribution";
import { createClient } from "@/lib/supabase";
import { PLAN_PRICES } from "@/lib/types";
import { PLANS, PAID_PLAN_ID, type PlanTier } from "./plans";

// While the Google Ads Phase 2 value screen runs, "Choose Pro" IS the pay-intent
// signal — it is the most explicit thing a user can do short of paying, and it
// happens at the moment they decide. Routing them elsewhere to click a second
// button lost people exactly there.
//
// The activation gate still holds: pay_intent only fires for a user who has
// received a fraud score, and /api/pay-intent enforces that server-side too. A
// user who has not scanned anything sees "try it first" instead, which is
// actionable for them — they still have free scans.
type CheckoutState =
  | "idle"
  | "redirecting"
  | "error"
  | "recorded"
  | "needs_activation";

/**
 * ScrollReveal — IntersectionObserver-driven wrapper used by the pricing page
 * to drive scroll-triggered animations (trust rail, FAQ cascade, CTA pulse).
 * Co-located here so the page stays a server component while we get the
 * one-time visibility toggle on the client. Reduced-motion users get the
 * static [data-visible="true"] state immediately.
 */
export function ScrollReveal({
  as,
  revealKind,
  className,
  children,
  ...rest
}: {
  as?: "section" | "div";
  revealKind: "rail" | "faq" | "cta";
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const Tag = (as ?? "section") as "section" | "div";
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Reduced-motion users skip the observer and render the final state.
    const prefersReduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReduce) {
      setVisible(true);
      return;
    }
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      // SSR / unsupported: fall back to visible so content is never trapped invisible.
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.15 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as React.Ref<HTMLElement & HTMLDivElement>}
      data-reveal={revealKind}
      data-visible={visible ? "true" : "false"}
      className={className}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export function PricingPlans() {
  const [state, setState] = useState<CheckoutState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  // null while loading. /pricing is login-gated by the middleware, so every
  // visitor here is authenticated — what varies is whether they have activated.
  const [user, setUser] = useState<string | null>(null);
  const [hasActivated, setHasActivated] = useState<boolean | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function loadActivation() {
      try {
        const supabase = createClient();
        const {
          data: { user: authUser },
        } = await supabase.auth.getUser();
        // RLS scopes this to the current user, so the count is their own scans.
        const { count } = await supabase
          .from("scans")
          .select("id", { count: "exact", head: true });
        if (cancelled) return;
        setUser(authUser?.id ?? null);
        setHasActivated((count ?? 0) > 0);
      } catch {
        if (!cancelled) setHasActivated(false);
      }
    }
    loadActivation();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onChoosePro() {
    // Render guard: only an authenticated, activated user can express pay intent.
    if (!user || !hasActivated) {
      setState("needs_activation");
      return;
    }
    if (firedRef.current) return;
    firedRef.current = true;
    setState("redirecting");
    setErrorMsg("");

    // checkout_start still fires: the user did begin the upgrade flow, and this
    // remains the monetize entry point once real payment returns in Phase 3.
    trackCheckoutStart({ plan: PAID_PLAN_ID });

    // utm_campaign is passed explicitly rather than left to PostHog's
    // super-property, which is registered from sessionStorage and does not
    // survive a return visit.
    const attribution = readAttribution(
      typeof window === "undefined" ? "" : window.location.search,
      typeof window === "undefined" ? null : window.sessionStorage,
    );
    trackPayIntent({
      plan: PAID_PLAN_ID,
      price_cents: PLAN_PRICES[PAID_PLAN_ID],
      gclid: attribution.gclid,
      utm_campaign: attribution.utm_campaign ?? "",
    });

    try {
      await fetch("/api/pay-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: PAID_PLAN_ID,
          gclid: attribution.gclid,
          utm_campaign: attribution.utm_campaign,
          distinct_id: getDistinctId(),
        }),
      });
    } catch {
      // The analytics event already fired, which is the primary signal. A failed
      // row write must not show an error for something that cost them nothing.
    }
    setState("recorded");
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        {PLANS.map((plan, index) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            // staggered, in-place reveal (translate + opacity, never bare fade)
            style={{ animationDelay: `${index * 90}ms` }}
            checkoutState={plan.id === PAID_PLAN_ID ? state : "idle"}
            onUpgrade={plan.id === PAID_PLAN_ID ? onChoosePro : undefined}
          />
        ))}
      </div>

      <EnterpriseBand />

      {/* Unconditionally-mounted live region (WCAG 4.1.3): text toggles, container stays. */}
      <p
        role="alert"
        aria-live="assertive"
        className={cn(
          "flex items-center justify-center gap-2 text-sm font-medium text-fraud",
          state === "error" ? "min-h-[1.5rem]" : "sr-only",
        )}
      >
        {state === "error" ? (
          <>
            <ShieldAlert className="size-4" aria-hidden="true" />
            {errorMsg}
          </>
        ) : (
          ""
        )}
      </p>
    </div>
  );
}

function PlanCard({
  plan,
  checkoutState,
  onUpgrade,
  style,
}: {
  plan: PlanTier;
  checkoutState: CheckoutState;
  onUpgrade?: () => void;
  style?: React.CSSProperties;
}) {
  const redirecting = checkoutState === "redirecting";
  const recorded = checkoutState === "recorded";
  const needsActivation = checkoutState === "needs_activation";

  return (
    <div
      style={style}
      className={cn(
        "group relative flex flex-col rounded-xl p-5 sm:p-6",
        "fs-reveal", // staggered entrance, defined in globals-scoped style below
        plan.featured
          ? // glass panel raised with signal-cyan ring + glow (no flat border on dark)
            "bg-card/80 shadow-[0_0_0_1px_rgba(56,189,207,0.30),0_0_40px_rgba(56,189,207,0.12),0_16px_40px_rgba(14,23,38,0.45)] backdrop-blur-md"
          : "bg-card/50 shadow-[0_0_0_1px_rgba(146,170,190,0.14),0_12px_30px_rgba(14,23,38,0.30)] backdrop-blur-sm",
      )}
    >
      {plan.featured && (
        <Badge className="absolute -top-3 right-7 border-transparent bg-signal px-3 py-1 font-mono text-[0.7rem] tracking-wide text-signal-foreground uppercase">
          {recorded ? "You're on the list" : "Most popular"}
        </Badge>
      )}

      <header className="space-y-1">
        <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground">
          {recorded ? "You're on the Pro early-access list" : plan.name}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {recorded
            ? "We'll email you when it's live. You have not been charged."
            : plan.tagline}
        </p>
      </header>

      <div className="mt-4 flex items-baseline gap-1.5">
        {plan.priceMonthly === 0 ? (
          <span className="font-mono text-4xl font-medium tracking-tight text-foreground tabular-nums">
            $0
          </span>
        ) : (
          <>
            <span className="font-mono text-5xl font-medium tracking-tight text-foreground tabular-nums">
              ${plan.priceMonthly}
            </span>
            <span className="text-sm text-muted-foreground">/ month</span>
          </>
        )}
      </div>

      <Separator className="my-6 bg-border" />

      <ul className="flex-1 space-y-2" aria-label={`${plan.name} plan features`}>
        {plan.features.map((feature) => (
          <li
            key={feature.label}
            className={cn(
              "flex items-start gap-3 text-sm",
              feature.included ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
                feature.included
                  ? "bg-signal/15 text-signal"
                  : "bg-muted text-muted-foreground/70",
              )}
            >
              {feature.included ? (
                <Check className="size-3.5" />
              ) : (
                <Minus className="size-3.5" />
              )}
            </span>
            <span className={feature.included ? "" : "line-through decoration-muted-foreground/40"}>
              {feature.label}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-6">
        {onUpgrade ? (
          recorded ? (
            <ProEarlyAccessConfirmation />
          ) : needsActivation ? (
            <TryItFirstPointer />
          ) : (
            <Button
              type="button"
              onClick={onUpgrade}
              disabled={redirecting}
              aria-label={redirecting ? "Recording your interest" : plan.cta}
              className={cn(
                "h-12 w-full rounded-full bg-signal text-base font-semibold text-signal-foreground",
                "transition-all duration-200 hover:bg-signal/90 hover:shadow-[var(--shadow-signal-glow)]",
                "focus-visible:ring-signal/50",
              )}
            >
              {redirecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>One moment…</span>
                </>
              ) : (
                <>
                  <span>{plan.cta}</span>
                  <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </>
              )}
            </Button>
          )
        ) : (
          <Link
            href="/signup"
            className={cn(
              buttonVariants({ variant: "outline" }),
              "h-12 w-full rounded-full border-border/70 text-base font-medium",
              "transition-all duration-200 hover:border-signal/50 hover:text-foreground",
            )}
          >
            {plan.cta}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Shown in the Pro card after a pay_intent has been recorded. This is the honest
 * confirmation the Phase 2 brief requires: no charge, no checkout, and we do NOT
 * ask for an email — the user is signed in, so we already have it.
 */
function ProEarlyAccessConfirmation() {
  return (
    <div className="rounded-2xl border border-signal/30 bg-signal/5 p-5 text-center">
      <p className="text-sm font-medium text-foreground">
        You&apos;re on the Pro early-access list
      </p>
      <p className="mt-2 text-sm text-muted-foreground">
        We&apos;ll email you when it&apos;s live. You have not been charged.
      </p>
    </div>
  );
}

/**
 * Shown when a signed-in user who has never received a fraud score clicks
 * "Choose Pro".
 *
 * Their click is not counted, deliberately: Phase 2 measures whether people who
 * USED the product will pay for it, and someone who has not scanned anything has
 * no idea what they would be buying. Counting them would measure curiosity.
 *
 * Unlike the quota-exhausted case, this is not a dead end — they still have free
 * scans, so "try it first" is something they can actually act on.
 */
function TryItFirstPointer() {
  return (
    <div className="rounded-2xl border border-border bg-card/60 p-5 text-center">
      <p className="text-sm font-medium text-foreground">Try it first</p>
      <p className="mt-2 text-sm text-muted-foreground">
        Scan a document free and see a real fraud score. The upgrade option is
        waiting on your results page.
      </p>
      <Link
        href="/dashboard"
        className={cn(
          buttonVariants({ variant: "outline" }),
          "mt-4 h-11 rounded-full px-6",
        )}
      >
        Scan a document free
      </Link>
    </div>
  );
}

/**
 * Enterprise band.
 *
 * Deliberately not a third price card: volume, SLAs and integration shape are
 * negotiated, and putting a number on them would either understate the deal or
 * scare the buyer off. It is also a different motion - Pro is self-serve, this
 * is a conversation.
 *
 * An intake form rather than a mailto. A mailto leaves the lead in one person's
 * inbox with nothing queryable behind it, and it loses the qualifying answers
 * that decide how the conversation should start.
 *
 * Three fields only. Email is never asked for - the visitor is signed in, so we
 * already have it, and the route reads it off the session rather than the body.
 * Intentionally fires no analytics event: the row is the signal, and a new
 * event mid-run would compete with pay_intent during the Phase 2 screen.
 */
function EnterpriseBand() {
  type SubmitState = "idle" | "open" | "submitting" | "sent" | "error";
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [company, setCompany] = useState("");
  const [volume, setVolume] = useState("");
  const [message, setMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const sending = submitState === "submitting";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    // Something has to be said. The route rejects an all-empty body too; this
    // just avoids a pointless round trip.
    if (!company.trim() && !volume && !message.trim()) {
      setErrorMsg("Tell us a little about your team so we know where to start.");
      setSubmitState("error");
      return;
    }
    setSubmitState("submitting");
    setErrorMsg("");
    try {
      const res = await fetch("/api/enterprise-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company: company.trim() || undefined,
          monthly_volume: volume || undefined,
          message: message.trim() || undefined,
        }),
      });
      if (!res.ok) throw new Error("send failed");
      setSubmitState("sent");
    } catch {
      setSubmitState("error");
      setErrorMsg("We couldn&apos;t send that. Please try again.");
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-5 backdrop-blur-sm sm:p-6">
      {submitState === "sent" ? (
        <div className="space-y-1">
          <h3 className="font-heading text-lg font-semibold tracking-tight text-foreground">
            Thanks &mdash; we&apos;ll be in touch
          </h3>
          <p className="text-sm text-muted-foreground">
            We&apos;ll reply to the address on your account. Nothing has been charged.
          </p>
        </div>
      ) : submitState === "idle" ? (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h3 className="font-heading text-lg font-semibold tracking-tight text-foreground">
              Enterprise
            </h3>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              Higher volume, API access, or a workflow of your own? Tell us how your
              team reviews documents and we&apos;ll put together something that fits.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => setSubmitState("open")}
            className="h-11 shrink-0 rounded-full px-6"
          >
            Talk to us
          </Button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <h3 className="font-heading text-lg font-semibold tracking-tight text-foreground">
              Enterprise
            </h3>
            <p className="text-sm text-muted-foreground">
              Three questions, then we&apos;ll come back to you.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label
                htmlFor="ent-company"
                className="text-xs font-medium text-muted-foreground"
              >
                Company
              </label>
              <Input
                id="ent-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                maxLength={120}
                placeholder="Acme Lending"
                disabled={sending}
              />
            </div>
            <div className="space-y-1.5">
              <label
                htmlFor="ent-volume"
                className="text-xs font-medium text-muted-foreground"
              >
                Documents reviewed per month
              </label>
              <select
                id="ent-volume"
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                disabled={sending}
                className="h-9 w-full rounded-[var(--radius-md)] border border-border bg-background px-3 text-sm text-foreground"
              >
                <option value="">Select a range</option>
                <option value="under-100">Under 100</option>
                <option value="100-500">100 &ndash; 500</option>
                <option value="500-2000">500 &ndash; 2,000</option>
                <option value="over-2000">Over 2,000</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="ent-message"
              className="text-xs font-medium text-muted-foreground"
            >
              How does your team review documents today, and does this need to
              connect to anything?
            </label>
            <textarea
              id="ent-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={2000}
              rows={3}
              disabled={sending}
              className="w-full rounded-[var(--radius-md)] border border-border bg-background px-3 py-2 text-sm text-foreground"
              placeholder="Two underwriters review by eye today. We would want it alongside our loan origination system."
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={sending}
              className="h-11 rounded-full bg-signal px-6 text-signal-foreground hover:bg-signal/90"
            >
              {sending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  <span>Sending&hellip;</span>
                </>
              ) : (
                <span>Send enquiry</span>
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setSubmitState("idle")}
              disabled={sending}
              className="h-11 text-muted-foreground hover:text-foreground"
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {/* Always mounted so the state change is announced, per WCAG 4.1.3. */}
      <p
        role="alert"
        aria-live="assertive"
        className={
          submitState === "error"
            ? "mt-3 flex items-center gap-2 text-sm font-medium text-destructive"
            : "sr-only"
        }
      >
        {submitState === "error" ? errorMsg : ""}
      </p>
    </div>
  );
}
