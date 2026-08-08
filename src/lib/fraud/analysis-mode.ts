/**
 * Analysis-mode classification — pure, testable module.
 *
 * The scan API accepts images as well as PDFs, but only PDFs get deep metadata
 * extraction (producer, creator, creation/modification dates, page count). Of
 * the 8 detectors in ./score.ts, 7 need that metadata — so an image's maximum
 * reachable score is 10, which always lands in the `clear` bucket (0–33). That
 * makes an image "clear" verdict an arithmetically guaranteed false negative.
 *
 * Surfaces therefore ask this module whether a scan received a *full* forensic
 * analysis before showing a score or a clear/suspect/fraud verdict.
 *
 * No I/O, no side-effects — safe to unit test.
 */

/** MIME type that receives the full forensic analysis (deep metadata checks). */
const FULL_ANALYSIS_MIME = "application/pdf";

/**
 * Whether a scan of this MIME type received the full forensic analysis.
 *
 * Deliberately an allow-list (strict equality against the single MIME with
 * deep checks) rather than an `image/*` deny-list: a future accepted file type
 * without deep checks then fails safe to "limited" instead of silently
 * inheriting a false "full" verdict. Case is NOT normalized and MIME
 * parameters are NOT stripped — strict equality keeps the fail-safe direction.
 *
 * @param mime - MIME type as persisted on the scan row (`file_meta.mime`)
 * @returns true only for an exact `application/pdf` match
 */
export function isFullAnalysis(mime: string): boolean {
  return mime === FULL_ANALYSIS_MIME;
}

// ---- User-facing copy for the limited-analysis state ----

/** Heading for the limited-analysis notice. */
export const LIMITED_ANALYSIS_TITLE = "Limited analysis";

/** Body copy for the limited-analysis notice. */
export const LIMITED_ANALYSIS_BODY =
  "Image files only receive basic checks today. For the full forensic scan, upload the original PDF.";
