"use client";

// "Manage billing" - opens the Stripe Billing Portal so a subscriber can cancel,
// swap card, or pull invoices.
//
// This is the product half of "Cancel anytime". Stripe checkout tells the
// customer they are charged "until you cancel" and the ad copy promises the
// same, so the app has to expose a real way to do it. Stripe hosts the portal;
// this component only fetches a one-time session URL and navigates to it.

import { useRef, useState } from "react";

type PortalState = "idle" | "opening" | "error";

export function ManageBilling() {
  const [state, setState] = useState<PortalState>("idle");
  const [message, setMessage] = useState("");
  // Fire-once latch, released on every outcome that does not navigate away, so
  // a failed attempt can never strand the customer with a dead button - the
  // same bug class that bricked the upgrade CTA.
  const firedRef = useRef(false);

  async function onManage() {
    if (firedRef.current) return;
    firedRef.current = true;
    setState("opening");
    setMessage("");

    try {
      const res = await fetch("/api/billing-portal", { method: "POST" });
      const payload = await res.json().catch(() => null);

      if (res.ok && payload?.url) {
        window.location.href = payload.url as string;
        return;
      }

      setMessage(
        res.status === 404
          ? "You do not have a billing subscription to manage."
          : "Could not open the billing portal. Please try again.",
      );
    } catch {
      setMessage("Could not reach the billing portal. Check your connection.");
    }

    firedRef.current = false;
    setState("error");
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={onManage}
        disabled={state === "opening"}
        aria-label={state === "opening" ? "Opening billing portal" : "Manage billing"}
        className="text-sm font-medium text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-60"
      >
        {state === "opening" ? "Opening…" : "Manage billing or cancel"}
      </button>
      {state === "error" && message ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {message}
        </p>
      ) : null}
    </div>
  );
}
