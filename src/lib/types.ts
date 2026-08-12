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
// Default free scan allowance before requiring a subscription
export const FREE_SCAN_QUOTA = 3;

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
