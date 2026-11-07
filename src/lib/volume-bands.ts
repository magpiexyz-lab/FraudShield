/**
 * The document-volume bands, in one place that a client component can import.
 *
 * DEPENDENCY-FREE ON PURPOSE. This module must stay importable from a
 * "use client" component, so it holds no imports at all — not even types from
 * a route. The bands used to live in src/app/api/enterprise-lead/route.ts,
 * which a client component cannot import without pulling the Supabase server
 * client and the rate limiter into the browser bundle. That is why
 * src/app/pricing/pricing-plans.tsx hardcoded the four values instead, and why
 * the API access dialog would otherwise have become a third copy of the scale.
 *
 * Same reasoning as src/lib/scan-limits.ts. A test asserts this file has no
 * import statement.
 *
 * Coarse bands, not a free-text number: nobody knows their exact monthly
 * volume, and a band separates a 50-document reviewer from a 5,000 well enough
 * to route the conversation.
 */
export const VOLUME_BANDS = [
  "under-100",
  "100-500",
  "500-2000",
  "over-2000",
] as const;

export type VolumeBand = (typeof VOLUME_BANDS)[number];

/**
 * What each band is called on screen. Kept beside the values so a new band
 * cannot be added without someone deciding what to call it — the failure mode
 * otherwise is a raw "over-2000" appearing in a dropdown.
 */
export const VOLUME_BAND_LABELS: Record<VolumeBand, string> = {
  "under-100": "Under 100",
  "100-500": "100 – 500",
  "500-2000": "500 – 2,000",
  "over-2000": "Over 2,000",
};
