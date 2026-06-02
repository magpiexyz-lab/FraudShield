// Landing-page A/B variants — sourced from experiment/experiment.yaml `variants`.
// The structural routing files (root page, /v/[variant] route) import VARIANTS
// and getVariant() from here; the shared <LandingContent> component (created by
// scaffold-landing) consumes the variant props (headline, subheadline, cta,
// pain_points). The default variant is the first one declared in experiment.yaml.

export interface Variant {
  slug: string;
  headline: string;
  subheadline: string;
  cta: string;
  pain_points: string[];
  promise: string;
  proof: string;
  urgency: string;
  pricing_amount: number;
  pricing_model: string;
  isDefault: boolean;
}

export const VARIANTS: readonly Variant[] = [
  {
    slug: "stop-the-loss",
    headline: "Stop Approving Fake Pay Stubs",
    subheadline:
      "Upload any pay stub, bank statement, or invoice and get a forensic fraud score in seconds — before you approve.",
    cta: "Scan Your First Document Free",
    pain_points: [
      "One fake pay stub can mean a defaulted loan you never recover",
      "AI fakes now pass a human eyeball check every time",
      "Enterprise fraud tools quote $50k+ and ignore small lenders",
    ],
    promise: "Catch forged documents before they cost you money",
    proof:
      "Metadata forensics plus a fraud-template database that grows with every scan",
    urgency: "AI document fraud jumped ~5x in 2025 — every approval is a gamble",
    pricing_amount: 49,
    pricing_model: "subscription",
    isDefault: true,
  },
  {
    slug: "seconds-not-hours",
    headline: "Verify Documents in Seconds, Not Hours",
    subheadline:
      "Skip the manual line-by-line review. Drop in a document and FraudShield returns a fraud score instantly.",
    cta: "Get Your Fraud Score Now",
    pain_points: [
      "Manually checking every statement eats hours you don't have",
      "You can't tell a real PDF from an AI-generated one by eye",
      "Hiring a forensic reviewer isn't realistic for a small team",
    ],
    promise: "Instant, automated document forensics for small teams",
    proof:
      "Checks metadata, cross-document consistency, and known fraud templates in one pass",
    urgency: "Every minute spent eyeballing docs is a minute a fraudster counts on",
    pricing_amount: 49,
    pricing_model: "subscription",
    isDefault: false,
  },
  {
    slug: "built-for-small-operators",
    headline: "Bank-Grade Fraud Detection, Small-Business Price",
    subheadline:
      "The forensic tooling big banks use, finally affordable for landlords, small lenders, and gig platforms.",
    cta: "Start Scanning Free",
    pain_points: [
      "Inscribe and Findigs only talk to enterprises through sales calls",
      "You're fighting $10 fraud kits with a free PDF viewer",
      "Nobody built affordable fraud detection for operators your size",
    ],
    promise: "Enterprise-quality document forensics priced for small operators",
    proof: "Self-serve — no sales call, no enterprise contract; sign up and scan",
    urgency: "Fraud kits sell for $10; staying unprotected costs far more",
    pricing_amount: 49,
    pricing_model: "subscription",
    isDefault: false,
  },
] as const;

/** The default variant (first declared in experiment.yaml: `stop-the-loss`). */
export const DEFAULT_VARIANT: Variant =
  VARIANTS.find((v) => v.isDefault) ?? VARIANTS[0];

/**
 * Resolve a variant by slug. Returns the default variant when `slug` is
 * undefined; returns `undefined` for an unknown slug so callers can decide
 * how to handle it (e.g., the dynamic route calls `notFound()`).
 */
export function getVariant(slug?: string): Variant | undefined {
  if (slug === undefined) return DEFAULT_VARIANT;
  return VARIANTS.find((v) => v.slug === slug);
}
