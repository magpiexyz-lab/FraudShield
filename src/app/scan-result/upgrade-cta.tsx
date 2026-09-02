"use client";

// Fake-door "Upgrade to Pro" CTA — the Google Ads Phase 2 value screen.
//
// Measures willingness to pay WITHOUT charging: the click fires `pay_intent`
// and records a row, then shows an honest early-access confirmation. There is
// no checkout, no payment provider import, and no email field — the user is
// already signed in, so asking again would both annoy them and violate the
// fake-door PII rule in .claude/stacks/analytics/posthog.md.
//
// The gate is ACTIVATION, not login. Someone who signed up but never received a
// fraud score has no idea what they would be buying; counting their click would
// measure curiosity rather than value.

import { useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trackPayIntent } from "@/lib/events";
import { getDistinctId } from "@/lib/analytics";
import { readAttribution } from "@/lib/attribution";
import { PLAN_PRICES } from "@/lib/types";

const PLAN_ID = "pro";

type Status = "idle" | "submitting" | "done";

export function UpgradeCta({
  user,
  hasActivated,
  ctaLabel,
  heading,
  body,
  variant = "card",
}: {
  /** Authenticated user id, or null when signed out. */
  user: string | null;
  /** True once this user has received a fraud score (a completed scan). */
  hasActivated: boolean;
  /**
   * Overrides the button text. The locked signal breakdown names what is
   * actually behind the lock ("Unlock all 4 forensic signals") rather than the
   * generic price label — the ask converts better when it is specific about
   * what the user gets back.
   */
  ctaLabel?: string;
  /** Overrides the card heading. */
  heading?: string;
  /** Overrides the supporting line under the heading. */
  body?: string;
  /**
   * "card" renders the bordered panel this component has always been.
   * "inline" drops the chrome so it can sit inside another container — the
   * locked-signals placeholder supplies its own.
   */
  variant?: "card" | "inline";
}) {
  const [status, setStatus] = useState<Status>("idle");
  const firedRef = useRef(false);

  // Render guard: both conditions must hold. Signed-out or not-yet-activated
  // users never see the offer.
  if (!user || !hasActivated) return null;

  const priceCents = PLAN_PRICES[PLAN_ID];
  const priceLabel = `$${Math.round(priceCents / 100)}/mo`;

  async function onUpgradeClick() {
    if (firedRef.current) return;
    firedRef.current = true;
    setStatus("submitting");

    // Read attribution at click time. This is the fallback source — the route
    // prefers the acquisition_* values persisted on the user record at signup.
    const attribution = readAttribution(
      typeof window === "undefined" ? "" : window.location.search,
      typeof window === "undefined" ? null : window.sessionStorage,
    );
    const distinctId = getDistinctId();

    // utm_campaign is passed explicitly rather than left to PostHog's
    // super-property: that property is registered from sessionStorage and does
    // not survive a return visit, and pay_intent can fire days after the click.
    trackPayIntent({
      plan: PLAN_ID,
      price_cents: priceCents,
      gclid: attribution.gclid,
      utm_campaign: attribution.utm_campaign ?? "",
    });

    try {
      await fetch("/api/pay-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: PLAN_ID,
          gclid: attribution.gclid,
          utm_campaign: attribution.utm_campaign,
          distinct_id: distinctId,
        }),
      });
    } catch {
      // The analytics event already fired, which is the primary signal. A failed
      // row write must not show the user an error for something that cost them
      // nothing — the DB and PostHog counts are reconciled at verdict time.
    }

    setStatus("done");
  }

  const shellClass =
    variant === "inline"
      ? "scroll-mt-8"
      : "mt-8 scroll-mt-8 rounded-lg border border-border bg-card p-6";

  return (
    <div id="upgrade-pro" className={shellClass}>
      <div aria-live="polite">
        {status === "done" ? (
          <div>
            <p className="font-medium text-foreground">
              You&apos;re on the Pro early-access list
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              We&apos;ll email you when it&apos;s live. You have not been charged.
            </p>
          </div>
        ) : (
          <div>
            <p className="font-medium text-foreground">
              {heading ?? "Need more than the free scans?"}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {body ??
                "Pro lifts the scan limit and unlocks the full forensic breakdown on every document."}
            </p>
            <button
              type="button"
              onClick={onUpgradeClick}
              disabled={status === "submitting"}
              className={cn(buttonVariants({ size: "lg" }), "mt-4")}
            >
              {status === "submitting"
                ? "One moment…"
                : (ctaLabel ?? `Upgrade to Pro · ${priceLabel}`)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
