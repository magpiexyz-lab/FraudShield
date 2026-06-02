// Pricing tier definitions for FraudShield.
// Prices are derived from the server-authoritative constants in src/lib/types.ts
// (FREE_SCAN_QUOTA, PLAN_PRICES). The /api/checkout route re-reads PLAN_PRICES
// server-side — the client never sends a price (see .claude/stacks/payment/stripe.md).

import { FREE_SCAN_QUOTA, PLAN_PRICES } from "@/lib/types";

export type PlanTier = {
  id: string; // matches a key in PLAN_PRICES when paid; "free" for the free tier
  name: string;
  tagline: string;
  /** Monthly price in whole dollars, or null for the free tier. */
  priceMonthly: number | null;
  /** True for the tier we want the eye to land on. */
  featured: boolean;
  /** CTA label rendered on the tier card. */
  cta: string;
  features: ReadonlyArray<{ label: string; included: boolean }>;
};

// $49.00 → 49 (PLAN_PRICES stores cents). Sourced, never hardcoded.
const PRO_PRICE_MONTHLY = Math.round(PLAN_PRICES.pro / 100);

export const PLANS: ReadonlyArray<PlanTier> = [
  {
    id: "free",
    name: "Free",
    tagline: "Try forensic detection on your real documents.",
    priceMonthly: 0,
    featured: false,
    cta: "Start scanning free",
    features: [
      { label: `${FREE_SCAN_QUOTA} document scans, total`, included: true },
      { label: "0–100 forensic fraud score", included: true },
      { label: "Per-signal breakdown & explanations", included: true },
      { label: "Pay stubs, bank statements & invoices", included: true },
      { label: "Metadata forensics", included: true },
      { label: "Cross-document consistency checks", included: false },
      { label: "Known-fraud-template matching", included: false },
      { label: "API access", included: false },
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "Unlimited scanning for teams that review every day.",
    priceMonthly: PRO_PRICE_MONTHLY,
    featured: true,
    cta: "Choose Pro",
    features: [
      { label: "Unlimited document scans", included: true },
      { label: "0–100 forensic fraud score", included: true },
      { label: "Per-signal breakdown & explanations", included: true },
      { label: "Pay stubs, bank statements & invoices", included: true },
      { label: "Metadata forensics", included: true },
      { label: "Cross-document consistency checks", included: true },
      { label: "Known-fraud-template matching", included: true },
      { label: "Priority support", included: true },
    ],
  },
];

// The single paid tier the upgrade CTA submits to /api/checkout.
export const PAID_PLAN_ID = "pro";
export const FREE_QUOTA = FREE_SCAN_QUOTA;
