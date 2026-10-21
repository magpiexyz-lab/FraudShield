"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { SCAN_PACKS } from "@/lib/types";
import { readAttribution } from "@/lib/attribution";
import {
  interpretCheckoutResponse,
  CHECKOUT_NETWORK_MESSAGE,
  type CheckoutOutcome,
} from "@/lib/checkout-client";
import { trackCheckoutStarted } from "@/lib/events";

/**
 * Buy scans outright, without a subscription.
 *
 * WHY IT EXISTS. A week of live checkout produced 8 real visitors from the ads
 * who opened Stripe and none who paid. The one who came back and said why said
 * the reason was price. Intent was never the problem -- more than half of the
 * people who reach the paywall click through to checkout -- so what changed is
 * the size of the commitment at the end, not the funnel in front of it.
 *
 * ONE COMPONENT, TWO SURFACES: the pricing page and the scan-result paywall.
 * The question is identical in both places, and two copies of a money button
 * would drift.
 *
 * SECONDARY BY CONSTRUCTION. Rendered as quiet outline buttons under the Pro
 * CTA, never beside it as an equal. Pro is unchanged and still the offer we
 * lead with; this is the smaller door for someone who has already decided the
 * subscription is too much.
 */
export function ScanPackOptions({
  surface,
  className,
}: {
  /** Which paywall this was offered from — carried into checkout_started. */
  surface: "pricing" | "scan_result";
  className?: string;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  // Fire-once latch, like the Pro CTA: a double click would otherwise open two
  // Stripe sessions and the second would be abandoned by construction.
  const firedRef = useRef(false);

  async function buy(packId: string) {
    if (firedRef.current) return;
    firedRef.current = true;
    setBusy(packId);
    setError("");

    trackCheckoutStarted({ plan: packId, surface });

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
          plan: packId,
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
      // Leaving the app for Stripe: the latch stays closed for the rest of
      // this document. assign() rather than setting location.href, which
      // react-hooks/immutability reads as mutating a value from outside the
      // component; the two are equivalent to the browser.
      window.location.assign(outcome.url);
      return;
    }

    // Released on every outcome that does NOT navigate away, so a rate limit
    // or a dropped connection cannot brick the button for the page session.
    firedRef.current = false;
    setBusy(null);
    setError(outcome.kind === "error" ? outcome.message : outcome.message);
  }

  return (
    <div className={cn("mt-4", className)}>
      <p className="text-center text-sm text-muted-foreground">
        Or just buy the scans you need
      </p>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        {SCAN_PACKS.map((pack) => (
          <button
            key={pack.id}
            type="button"
            onClick={() => buy(pack.id)}
            disabled={busy !== null}
            className={cn(
              "flex-1 rounded-lg border border-border px-4 py-2.5 text-sm",
              "text-foreground transition-colors",
              "hover:border-signal/50 disabled:opacity-60",
            )}
          >
            {busy === pack.id ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                Securing checkout…
              </span>
            ) : (
              <>
                <span className="font-medium">{pack.label}</span>
                {/* Cents are formatted rather than assumed whole: $19.00 reads
                    as a price, 1900 reads as a bug. */}
                <span className="ml-2 text-muted-foreground">
                  ${(pack.price_cents / 100).toFixed(2)}
                </span>
              </>
            )}
          </button>
        ))}
      </div>

      <p className="mt-2 text-center text-xs text-muted-foreground">
        One-off payment. Scans never expire.
      </p>

      {/* Unconditionally mounted live region (WCAG 4.1.3): the text toggles,
          the container stays. */}
      <p role="status" aria-live="polite" className="mt-2 text-center text-sm text-destructive">
        {error}
      </p>
    </div>
  );
}
