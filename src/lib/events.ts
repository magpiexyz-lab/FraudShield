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
  checkout_start: "monetize",
  pay_success: "monetize",
  retain_return: "retain",
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

export function trackSignupStart() {
  track("signup_start", { funnel_stage: "activate" });
}

export function trackSignupComplete() {
  track("signup_complete", { funnel_stage: "activate" });
}

export function trackActivate(props: { doc_type: string; fraud_score?: number }) {
  track("activate", { ...props, funnel_stage: "activate" });
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
