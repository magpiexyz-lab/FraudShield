// What an upload may be: the accepted MIME types and the size caps, for both
// the authenticated scan and the anonymous free scan.
//
// ============================================================================
// THIS FILE MUST STAY DEPENDENCY-FREE. NO IMPORTS. NOT EVEN A TYPE IMPORT.
// ============================================================================
//
// It is imported by src/components/free-scan-panel.tsx, a client component on
// the LANDING PAGE — the cold paid-ad entry point, and the one bundle in this
// product whose size is paid for per click.
//
// These four values used to live in lib/scan-intake.ts, which does a
// top-level `import exifr from "exifr"` for extractImageMetadata. Webpack
// drops unused exports, but it only drops that import itself if the exifr
// package declares `sideEffects: false` — which could not be verified. So the
// limits moved here, to a module that pulls in nothing, and the panel reads
// them from here. lib/scan-intake.ts re-exports them, so every existing
// import path still works and /api/scan is untouched.
//
// The tidy that breaks this is small and plausible: pulling `DocumentMetadata`
// or a scoring type in "so the types live together" would reattach the whole
// fraud-pipeline graph — and through it exifr and sharp — to the landing page.
// tests/scan-limits.test.ts parses this file and fails on any import,
// re-export-from, dynamic import or require. Add the dependency to
// lib/scan-intake.ts instead; that module is server-side only.

/** The document types the scoring engine is calibrated for. */
export type DocType = "pay_stub" | "bank_statement" | "invoice";

// Server-side accepted MIME + size cap for the AUTHENTICATED path (the client
// also checks; the server is the authoritative gate).
export const ACCEPTED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
]);
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Anonymous free-scan limits. Deliberately STRICTER than the authenticated
// path: an anonymous upload must never be laxer, and these two constants are
// what bound the cost of an uncapped-by-account surface.
//
// DERIVED from ACCEPTED_MIME by filtering, never retyped. A second
// hand-written list is how adding a format to one surface silently fails to
// reach the other, and how removing one silently leaves the anonymous path
// accepting it.
export const ANON_ACCEPTED_MIME: ReadonlySet<string> = new Set(
  [...ACCEPTED_MIME].filter((m) => m.startsWith("image/")),
);
export const MAX_ANON_BYTES = 4 * 1024 * 1024; // 4 MB
