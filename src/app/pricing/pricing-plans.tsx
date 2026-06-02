"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Minus, Loader2, ShieldAlert, ArrowRight } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { trackCheckoutStart } from "@/lib/events";
import { PLANS, PAID_PLAN_ID, type PlanTier } from "./plans";

type CheckoutState = "idle" | "redirecting" | "error";

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

  async function startCheckout() {
    setState("redirecting");
    setErrorMsg("");
    // Fire the monetize event before leaving the app — never send a price; the
    // /api/checkout route looks up PLAN_PRICES server-side.
    trackCheckoutStart({ plan: PAID_PLAN_ID });
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: PAID_PLAN_ID }),
      });
      if (!res.ok) throw new Error(`Checkout failed (${res.status})`);
      const data: { url?: string } = await res.json();
      if (!data.url) throw new Error("No checkout URL returned");
      window.location.assign(data.url);
    } catch {
      setState("error");
      setErrorMsg("We couldn't start checkout. Please try again.");
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        {PLANS.map((plan, index) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            // staggered, in-place reveal (translate + opacity, never bare fade)
            style={{ animationDelay: `${index * 90}ms` }}
            checkoutState={plan.id === PAID_PLAN_ID ? state : "idle"}
            onUpgrade={plan.id === PAID_PLAN_ID ? startCheckout : undefined}
          />
        ))}
      </div>

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

  return (
    <div
      style={style}
      className={cn(
        "group relative flex flex-col rounded-xl p-7 sm:p-8",
        "fs-reveal", // staggered entrance, defined in globals-scoped style below
        plan.featured
          ? // glass panel raised with signal-cyan ring + glow (no flat border on dark)
            "bg-card/80 shadow-[0_0_0_1px_rgba(56,189,207,0.30),0_0_40px_rgba(56,189,207,0.12),0_16px_40px_rgba(14,23,38,0.45)] backdrop-blur-md"
          : "bg-card/50 shadow-[0_0_0_1px_rgba(146,170,190,0.14),0_12px_30px_rgba(14,23,38,0.30)] backdrop-blur-sm",
      )}
    >
      {plan.featured && (
        <Badge className="absolute -top-3 right-7 border-transparent bg-signal px-3 py-1 font-mono text-[0.7rem] tracking-wide text-signal-foreground uppercase">
          Most popular
        </Badge>
      )}

      <header className="space-y-1.5">
        <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
          {plan.name}
        </h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {plan.tagline}
        </p>
      </header>

      <div className="mt-6 flex items-baseline gap-1.5">
        {plan.priceMonthly === 0 ? (
          <span className="font-mono text-5xl font-medium tracking-tight text-foreground tabular-nums">
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

      <ul className="flex-1 space-y-3" aria-label={`${plan.name} plan features`}>
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

      <div className="mt-8">
        {onUpgrade ? (
          <Button
            type="button"
            onClick={onUpgrade}
            disabled={redirecting}
            aria-label={redirecting ? "Redirecting to secure checkout" : plan.cta}
            className={cn(
              "h-12 w-full rounded-full bg-signal text-base font-semibold text-signal-foreground",
              "transition-all duration-200 hover:bg-signal/90 hover:shadow-[var(--shadow-signal-glow)]",
              "focus-visible:ring-signal/50",
            )}
          >
            {redirecting ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                <span>Securing checkout…</span>
              </>
            ) : (
              <>
                <span>{plan.cta}</span>
                <ArrowRight className="size-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </>
            )}
          </Button>
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
