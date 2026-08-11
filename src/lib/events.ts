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
  pay_intent: "monetize",
  checkout_start: "monetize",
  pay_success: "monetize",
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

// monetize — fake door (no payment stack dependency)

/**
 * Google Ads Phase 2 value screen. Fires when an activated user clicks the
 * fake-door Upgrade CTA. Nobody is charged.
 *
 * `utm_campaign` is a required argument rather than an optional one on purpose:
 * the Phase 2 verdict isolates its numerator on this property, and PostHog's
 * `utm_campaign` super-property is registered from sessionStorage, which does
 * not survive a return visit. `pay_intent` is a deep-funnel event that can fire
 * days after the ad click, so the value must be passed explicitly. Pass "" when
 * there is genuinely no campaign.
 */
export function trackPayIntent(props: {
  plan: string;
  price_cents: number;
  gclid?: string;
  utm_campaign: string;
}) {
  track("pay_intent", { ...props, funnel_stage: "monetize" });
}

// --- Payment events (only when requires: [payment] matched) ---

export function trackCheckoutStart(props?: { plan?: string }) {
  track("checkout_start", { ...props, funnel_stage: "monetize" });
}

export function trackPaySuccess(props?: { plan?: string; amount?: number }) {
  track("pay_success", { ...props, funnel_stage: "monetize" });
}

// retain

export function trackRetainReturn(props?: { days_since_last?: number }) {
  track("retain_return", { ...props, funnel_stage: "retain" });
}
