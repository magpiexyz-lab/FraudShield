import { track } from "./analytics";

// --- Event funnel stage map (generated from experiment/EVENTS.yaml) ---

export const EVENT_FUNNEL_MAP: Record<string, string> = {
  visit_landing: "reach",
  demo_view: "reach",
  cta_click: "demand",
  api_interest_click: "demand",
  signup_start: "activate",
  signup_complete: "activate",
  activate: "activate",
  paywall_shown: "monetize",
  checkout_started: "monetize",
  subscription_activated: "monetize",
  invoice_paid: "retain",
  payment_failed: "retain",
  subscription_canceled: "retain",
  retain_return: "retain",
  feedback_submitted: "activate",
} as const;

// --- Event wrappers (generated from experiment/EVENTS.yaml events map) ---

// reach

export function trackVisitLanding(props?: { variant?: string }) {
  track("visit_landing", { ...props, funnel_stage: "reach" });
}

export function trackDemoView(props?: { variant?: string }) {
  track("demo_view", { ...props, funnel_stage: "reach" });
}

// demand

export function trackCtaClick(props?: { variant?: string }) {
  track("cta_click", { ...props, funnel_stage: "demand" });
}

export function trackApiInterestClick(props?: { doc_type?: string }) {
  track("api_interest_click", { ...props, funnel_stage: "demand" });
}

// activate

export function trackSignupStart(props?: { method?: "email" | "google" }) {
  track("signup_start", { ...props, funnel_stage: "activate" });
}

export function trackSignupComplete(props?: { method?: "email" | "google" }) {
  track("signup_complete", { ...props, funnel_stage: "activate" });
}

export function trackActivate(props: { doc_type: string; fraud_score?: number }) {
  track("activate", { ...props, funnel_stage: "activate" });
}

export function trackFeedbackSubmitted(props: {
  source?: string;
  feedback?: string;
  activation_action: string;
}) {
  track("feedback_submitted", { ...props, funnel_stage: "activate" });
}

// monetize

/**
 * Fires when a paywall surface RENDERS, not when it is clicked.
 *
 * checkout_start alone cannot distinguish "nobody wants to pay" from "nobody was
 * ever asked": a zero rate looks identical in both cases. This event supplies
 * the missing denominator — of the people who hit a paywall, how many acted.
 *
 * Call it once per mount behind a ref guard. Firing per render would inflate
 * the count with every re-render and make the ratio meaningless.
 */
export function trackPaywallShown(props: {
  surface: "locked_signals" | "scan_result_quota" | "dashboard_quota" | "pricing";
  signal_count?: number;
}) {
  track("paywall_shown", { ...props, funnel_stage: "monetize" });
}

// --- Payment events (only when requires: [payment] matched) ---
// The five names below are the Phase 3 paid funnel and are read literally by
// the fleet readiness check. Do not rename them without updating that contract.

// Client-side: fired from the two upgrade CTAs.
export function trackCheckoutStarted(props?: { plan?: string; surface?: string }) {
  track("checkout_started", { ...props, funnel_stage: "monetize" });
}

// The four below are fired SERVER-side from the Stripe webhook via
// trackServerEvent, because only Stripe can confirm money actually moved. These
// wrappers exist so the names stay in one place and the typed contract holds;
// see src/app/api/webhooks/stripe/route.ts for the call sites.
export function trackSubscriptionActivated(props?: { plan?: string; amount?: number }) {
  track("subscription_activated", { ...props, funnel_stage: "monetize" });
}

export function trackInvoicePaid(props?: { amount?: number; billing_reason?: string }) {
  track("invoice_paid", { ...props, funnel_stage: "retain" });
}

export function trackPaymentFailed(props?: { amount?: number }) {
  track("payment_failed", { ...props, funnel_stage: "retain" });
}

export function trackSubscriptionCanceled(props?: { plan?: string }) {
  track("subscription_canceled", { ...props, funnel_stage: "retain" });
}

// retain

export function trackRetainReturn(props?: { days_since_last?: number }) {
  track("retain_return", { ...props, funnel_stage: "retain" });
}
