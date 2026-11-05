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

// ===========================================================================
// THE ANONYMOUS DECODE POLICY
//
// ANON_ACCEPTED_MIME is checked against `file.type` — the CLIENT-SUPPLIED
// multipart Content-Type. It is a LABEL CHECK, and the two constants below
// exist because a label is not a format: an SVG sent as `image/png` passed the
// MIME gate, and sharp decoded it. A 0.02 MB SVG of ~300 stacked
// `feGaussianBlur` layers was measured at 229,141 ms in the free-scan decode,
// against a 60-second lambda — one request, a full minute of billed compute, a
// 504 for the visitor, and 20 of them allowed per IP per hour.
//
// So /api/free-scan sniffs the REAL format with `sharp().metadata()` (23 ms
// against 47,959 ms for a filtered render, measured on this install) and
// refuses anything outside the list below. /api/scan passes neither constant
// and is unchanged — see prepareImage in lib/fraud/vision.ts.
// ===========================================================================

/**
 * MIME -> the format name libvips reports for it.
 *
 * NOT a second accept-list: it is a translation table, and the Set below is
 * built by mapping ANON_ACCEPTED_MIME THROUGH it. A type added to
 * ACCEPTED_MIME with no entry here is dropped from the decode allow-list, so
 * the drift direction is fail-closed — the new format is refused at the decode
 * rather than silently admitted.
 */
const VIPS_FORMAT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  // libvips reports every HEIF-container image as "heif", AVIF included. HEIC
  // stays on the list because ANON_ACCEPTED_MIME names it; sharp's prebuilt
  // binaries have no HEVC decoder, so a real HEIC still fails the render and
  // still gets the conversion-framed `image_unreadable` copy it gets today.
  "image/heic": "heif",
};

/**
 * The formats the anonymous decode will actually render, by DETECTED format.
 *
 * Derived from ANON_ACCEPTED_MIME, never retyped — same rule, same reason as
 * ANON_ACCEPTED_MIME's own derivation from ACCEPTED_MIME.
 */
export const ANON_DECODE_FORMATS: ReadonlySet<string> = new Set(
  [...ANON_ACCEPTED_MIME]
    .map((m) => VIPS_FORMAT_BY_MIME[m])
    .filter((f): f is string => Boolean(f)),
);

/**
 * Hard ceiling on input pixels for the anonymous decode.
 *
 * 48 MP: the largest common phone sensor output (a 48 MP main camera), so no
 * photograph a visitor can take of a payslip is refused by it. sharp's default
 * is ~268 MP — about 800 MB of raw pixels — and the anonymous input is
 * downscaled to a 1568px long edge regardless, so nothing above this is ever
 * used. At 3 bytes per pixel this bounds one decode at ~144 MB, well inside
 * the function's memory.
 *
 * DEFENCE IN DEPTH, NOT THE SVG FIX: the measured bomb was ~4 megapixels and
 * would pass this ceiling untouched. ANON_DECODE_FORMATS is what stops it.
 */
export const MAX_ANON_INPUT_PIXELS = 48_000_000;
