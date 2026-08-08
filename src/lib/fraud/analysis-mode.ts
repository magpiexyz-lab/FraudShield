/**
 * Analysis-mode classification — pure, testable module.
 *
 * The scan API accepts images as well as PDFs. Images now get their own
 * metadata pass — the EXIF Software tag, DateTimeOriginal, and absence-of-EXIF
 * feed three real detectors in ./score.ts, so an image scan can reach the
 * `suspect` and `fraud` buckets on its own evidence. That is a *partial*
 * analysis, not a full one: the document-level forensics in ./score.ts (PDF
 * producer/creator fingerprinting, template matching, creation-vs-modification
 * timestamp analysis, page and size heuristics) have no image equivalent and
 * still require the original PDF.
 *
 * Surfaces therefore ask this module whether a scan received a *full* forensic
 * analysis, so a partial result is labelled as such rather than presented as a
 * complete verdict.
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
export const LIMITED_ANALYSIS_TITLE = "Partial analysis";

/** Body copy for the limited-analysis notice. */
export const LIMITED_ANALYSIS_BODY =
  "Image files receive metadata checks — editing software, capture date, and stripped or missing EXIF. Full document forensics, including producer fingerprinting and template matching, needs the original PDF.";
