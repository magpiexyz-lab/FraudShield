"use client";

// "Upgrade to Pro" CTA on the scan-result page.
//
// Phase 3: this opens a REAL Stripe subscription checkout via POST
// /api/checkout. The fake door (pay_intent + the early-access confirmation)
// is retired - nothing here may suggest success before Stripe has actually
// taken a payment, and the only success path is a redirect off this page.
//
// The gate is ACTIVATION, not login. Someone who signed up but never received
// a fraud score has no idea what they would be buying, and b-06 asserts the
// CTA is absent for a signed-out visitor.
//
// This component is mounted several times on the result page, so every piece
// of state (including the fire-once latch) is per-instance by construction.

import { useRef, useState } from "react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trackCheckoutStart } from "@/lib/events";
import { readAttribution } from "@/lib/attribution";
import {
  interpretCheckoutResponse,
  CHECKOUT_NETWORK_MESSAGE,
  type CheckoutOutcome,
} from "@/lib/checkout-client";
import { PLAN_PRICES } from "@/lib/types";

const PLAN_ID = "pro";

type Status = "idle" | "submitting" | "error" | "not_configured";

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
   * generic price label - the ask converts better when it is specific about
   * what the user gets back.
   */
  ctaLabel?: string;
  /** Overrides the card heading. */
  heading?: string;
  /** Overrides the supporting line under the heading. */
  body?: string;
  /**
   * "card" renders the bordered panel this component has always been.
   * "inline" drops the chrome so it can sit inside another container - the
   * locked-signals placeholder supplies its own.
   */
  variant?: "card" | "inline";
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const firedRef = useRef(false);

  // Render guard: both conditions must hold. Signed-out or not-yet-activated
  // users never see the offer.
  if (!user || !hasActivated) return null;

  const priceCents = PLAN_PRICES[PLAN_ID];
  const priceLabel = "$" + Math.round(priceCents / 100) + "/mo";

  async function onUpgradeClick() {
    // Fire-once latch: a double-click must not open two Stripe sessions. It is
    // released again on every outcome that does not navigate, so a 429 or a
    // dropped connection cannot permanently disable the upgrade.
    if (firedRef.current) return;
    firedRef.current = true;
    setStatus("submitting");
    setMessage("");

    // checkout_start also fires from /pricing. Both upgrade surfaces emit it so
    // the monetize funnel counts the same action wherever it was taken.
    trackCheckoutStart({ plan: PLAN_ID });

    // Read attribution at click time. This is the FALLBACK source - the route
    // prefers the acquisition_* values persisted on the user record at signup.
    // PostHog super-properties are registered from sessionStorage and do not
    // survive a return visit, so the values are passed explicitly.
    const attribution = readAttribution(
      typeof window === "undefined" ? "" : window.location.search,
      typeof window === "undefined" ? null : window.sessionStorage,
    );

    let outcome: CheckoutOutcome;
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: PLAN_ID,
          gclid: attribution.gclid,
          utm_campaign: attribution.utm_campaign,
        }),
      });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        // Non-JSON body (proxy error page, empty 502): decide on status alone.
      }
      outcome = interpretCheckoutResponse(res.status, payload);
    } catch {
      outcome = { kind: "error", message: CHECKOUT_NETWORK_MESSAGE };
    }

    if (outcome.kind === "redirect") {
      // Leaving the app: keep the latch closed for the rest of this document.
      window.location.href = outcome.url;
      return;
    }

    firedRef.current = false;
    setMessage(outcome.message);
    setStatus(outcome.kind === "not_configured" ? "not_configured" : "error");
  }

  const shellClass =
    variant === "inline"
      ? "scroll-mt-8"
      : "mt-8 scroll-mt-8 rounded-lg border border-border bg-card p-6";

  return (
    <div id="upgrade-pro" className={shellClass}>
      <div aria-live="polite">
        <p className="font-medium text-foreground">
          {heading ?? "Need more than the free scans?"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {body ??
            "Pro lifts the scan limit and unlocks the full forensic breakdown on every document."}
        </p>

        {status === "not_configured" ? (
          // Stripe is not wired up in this environment. Point at /pricing,
          // which owns the waitlist form, rather than duplicating it here.
          <div className="mt-4">
            <p className="text-sm text-muted-foreground">{message}</p>
            <Link
              href="/pricing"
              className={cn(buttonVariants({ size: "lg" }), "mt-3")}
            >
              Join the Pro waitlist
            </Link>
          </div>
        ) : (
          <button
            type="button"
            onClick={onUpgradeClick}
            disabled={status === "submitting"}
            className={cn(buttonVariants({ size: "lg" }), "mt-4")}
          >
            {status === "submitting"
              ? "Securing checkout…"
              : (ctaLabel ?? "Upgrade to Pro · " + priceLabel)}
          </button>
        )}

        {status === "error" && message ? (
          <p role="alert" className="mt-3 text-sm font-medium text-fraud">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
