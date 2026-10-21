// Database row types for FraudShield
// Named with XxxRow convention per wire.md Step 6.
// These reflect the 3 tables: scans, subscriptions, api_waitlist
// plus the idempotency table: stripe_events

// --- scans ---
// Raw documents are NOT persisted — only extracted metadata + score.
export type ScansRow = {
  id: string;                     // uuid primary key
  user_id: string;                // FK auth.users(id)
  doc_type: string;               // "pay_stub" | "bank_statement" | "invoice"
  fraud_score: number;            // 0–100 integer
  signals: FraudSignal[];         // jsonb: per-signal breakdown
  file_meta: FileMeta;            // jsonb: filename, mime, size, pdf metadata
  // False when the scan produced a partial analysis (an image whose AI content
  // pass did not complete). Those return EXIF evidence but no fraud score, so
  // they do not spend one of the free scans.
  counts_toward_quota: boolean;
  // What the content-analysis call cost, as the API reported it. NULL when the
  // scan never reached the model (pre-migration rows, no API key, undecodable
  // upload) — not zero, which would be a measurement rather than an absence.
  // `model` is stored with the counts because input and output are billed at
  // per-model rates, so the numbers cannot be priced without it.
  input_tokens: number | null;
  output_tokens: number | null;
  model: string | null;
  created_at: string;             // timestamptz
};

// Signal shape returned by the fraud scoring engine
export type FraudSignal = {
  id: string;
  label: string;
  severity: "clear" | "suspect" | "fraud";
  detail: string;
  weight: number;
};

// File metadata (no raw file stored)
export type FileMeta = {
  filename: string;
  mime: string;
  size: number;
  pdf_producer?: string;
  pdf_creator?: string;
  pdf_created?: string;
  pdf_modified?: string;
  page_count?: number;
  // Image (EXIF) fields — see extractImageMetadata in app/api/scan/route.ts
  exif_software?: string;
  exif_datetime_original?: string;
  exif_present?: boolean;
  // AI content pass — see lib/fraud/vision.ts. vision_analyzed is what
  // lib/fraud/analysis-mode.ts classifies an image scan as full analysis on.
  vision_analyzed?: boolean;
  vision_status?: string;
};

// --- subscriptions ---
export type SubscriptionsRow = {
  id: string;                           // uuid primary key
  user_id: string;                      // FK auth.users(id)
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: "active" | "inactive" | "canceled" | "past_due";
  plan: string;                         // e.g. "pro"
  scan_quota: number;                   // total scans allowed per billing period
  // Scans bought outright through a one-time purchase. Cumulative and never
  // expiring: this only ever increases, and remaining scans are computed as
  // (free quota + scan_credits) minus scans used. Zero, never null — a user
  // who has bought nothing has bought zero, which is a fact, not an unknown.
  scan_credits: number;
  current_period_start: string | null;  // timestamptz billing anchor; NULL = all-time
  created_at: string;                   // timestamptz
};

// --- api_waitlist ---
// Captures b-05 fake-door interest ("Get API access")
export type ApiWaitlistRow = {
  id: string;         // uuid primary key
  user_id: string | null;   // nullable — anonymous users can also register interest
  email: string;
  created_at: string; // timestamptz
};

// --- stripe_events (idempotency table) ---
export type StripeEventsRow = {
  stripe_event_id: string;  // text primary key
  received_at: string;      // timestamptz
};

// --- Free scan quota constants ---
// Default free scan allowance before requiring a subscription.
//
// Cut from 3 to 1 after Phase 2 returned zero pay-intents across ~170 paid
// clicks. Three scans plus an unlocked forensic breakdown meant a visitor could
// answer their question completely and leave with no reason to pay; one scan
// establishes the product works and then the paywall is the only way forward.
export const FREE_SCAN_QUOTA = 1;

// Monthly scan allowance on the paid plan.
//
// Pro was originally sold as "unlimited", which is unsafe here: every image
// scan makes a vision API call, so unlimited scanning at a flat price means
// unbounded cost per customer. A cap bounds the worst case without touching the
// price — 200 scans is roughly $6-20 of API cost against a $60 plan, and for a
// small lender it is ~10 documents a working day, so real users should never
// reach it.
export const PRO_SCAN_QUOTA = 200;

// Plan pricing (server-authoritative — never trust client-provided prices)
export const PLAN_PRICES: Record<string, number> = {
  pro: 6000, // $60.00 in cents
};

/**
 * Scans bought outright, with no subscription.
 *
 * WHY THESE EXIST. A week of live checkout produced 8 real visitors who opened
 * Stripe and none who paid; the one who came back and said why said the reason
 * was price. Intent was never the problem -- more than half of the people who
 * reach the paywall click through to checkout -- so what changed is the size of
 * the commitment at the end, not the funnel in front of it.
 *
 * SEPARATE FROM PLAN_PRICES, deliberately. Everything in PLAN_PRICES is a
 * recurring subscription and the checkout route opens it in Stripe's
 * "subscription" mode; these open in "payment" mode, grant credits rather than
 * a quota, and never renew. Folding them into one map would mean every reader
 * of PLAN_PRICES having to ask which kind it got.
 *
 * CREDITS DO NOT EXPIRE — see supabase/migrations/014_scan_credits.sql for why
 * that is a decision rather than an omission.
 */
export type ScanPack = {
  /** Stable id, used as the `plan` value through checkout and the webhook. */
  id: string;
  label: string;
  /** Scans granted on purchase. */
  scans: number;
  /** Price in cents. Server-authoritative, like PLAN_PRICES. */
  price_cents: number;
};

export const SCAN_PACKS: ReadonlyArray<ScanPack> = [
  {
    id: "scan_1",
    label: "Single scan",
    scans: 1,
    price_cents: 700, // $7.00
  },
  {
    id: "scan_5",
    label: "5-scan pack",
    scans: 5,
    price_cents: 1900, // $19.00 — $3.80 a scan
  },
];

/** Look up a pack by the id that travels through checkout metadata. */
export function scanPackById(id: string | null | undefined): ScanPack | null {
  if (!id) return null;
  return SCAN_PACKS.find((p) => p.id === id) ?? null;
}
