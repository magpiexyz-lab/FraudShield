/**
 * Analysis-mode classification — pure, testable module.
 *
 * A scan can receive one of three depths of analysis, and the result surfaces
 * must not present one as another:
 *
 *   full_pdf     — the original PDF, with BOTH passes complete: document-level
 *                  metadata forensics (producer/creator fingerprinting,
 *                  template matching, creation-vs-modification timestamps,
 *                  page and size heuristics) AND the AI content pass.
 *
 *                  The content pass is new here. This mode used to mean
 *                  metadata only, and the accuracy gate (#49) measured the
 *                  consequence: 0 of 20 forged PDFs detected, because nothing
 *                  in the metadata path reads the numbers on the page.
 *   full_image   — an image whose content was successfully analysed by the AI
 *                  content pass (lib/fraud/vision.ts), on top of the EXIF
 *                  metadata checks. Different evidence from a PDF scan, but a
 *                  complete pass over what an image can actually be checked on:
 *                  once a document is photographed, the metadata describes the
 *                  capture and only the content is left to check.
 *   partial      — an image where the content pass did not produce a
 *                  determination (no key, timeout, API error, refusal, or an
 *                  inconclusive verdict). EXIF checks only — real signals, but
 *                  not a complete picture.
 *
 * Note that none of these certify a document as genuine. "No indicators found"
 * is the absence of evidence, and every copy constant below is written to say
 * so rather than imply a clean bill of health.
 *
 * No I/O, no side-effects — safe to unit test.
 */

/** MIME type that receives the full document-metadata forensics. */
const FULL_ANALYSIS_MIME = "application/pdf";

/** The three analysis depths. See the module comment. */
export type AnalysisMode = "full_pdf" | "full_image" | "partial";

/**
 * The subset of a scan's `file_meta` this module classifies on.
 * Accepts the persisted row shape directly.
 */
export type AnalysisSubject = {
  mime: string;
  vision_analyzed?: boolean;
};

/**
 * Classify how deeply a scan was actually analysed.
 *
 * Fails safe in both directions: an unknown MIME falls to `partial`, and an
 * image only reaches `full_image` when the content pass explicitly recorded a
 * determination (`vision_analyzed === true`, which only the scan route sets and
 * only on a usable vision result). A missing or malformed `file_meta` — an old
 * row, a failed fetch — is `partial`.
 *
 * @param meta - the scan's `file_meta`, or null/undefined if unavailable
 */
export function analysisMode(
  meta: AnalysisSubject | null | undefined,
): AnalysisMode {
  if (!meta || typeof meta.mime !== "string") return "partial";

  // A PDF is full ONLY when the content pass also returned a determination.
  //
  // It used to qualify on MIME alone, because PDFs received document-level
  // metadata forensics and that was the whole of the analysis available to
  // them. The accuracy gate (#49) showed what that was worth: 0 of 20 forged
  // PDFs caught, scores a constant per document type, genuine and tampered
  // indistinguishable. Metadata cannot see an edited salary.
  //
  // PDFs now go through the content pass too, so the same rule applies to them
  // as to images: a scan whose content was never read is partial, whatever its
  // format. Calling it full on format alone is how a document that was not
  // examined gets presented as one that was.
  if (meta.mime === FULL_ANALYSIS_MIME) {
    return meta.vision_analyzed === true ? "full_pdf" : "partial";
  }
  if (meta.mime.startsWith("image/") && meta.vision_analyzed === true) {
    return "full_image";
  }
  return "partial";
}

/**
 * Whether a scan received a complete analysis for its file type — i.e. whether
 * its score can be presented as a finished verdict rather than a partial one.
 *
 * @param meta - the scan's `file_meta`, or null/undefined if unavailable
 */
export function isFullAnalysis(
  meta: AnalysisSubject | null | undefined,
): boolean {
  return analysisMode(meta) !== "partial";
}

// ---- User-facing copy: partial (metadata-only) analysis ----

/** Heading for the limited-analysis notice. */
export const LIMITED_ANALYSIS_TITLE = "Partial analysis";

/** Body copy for the limited-analysis notice. */
export const LIMITED_ANALYSIS_BODY =
  "Image files receive metadata checks — editing software, capture date, and stripped or missing EXIF. Full document forensics, including producer fingerprinting and template matching, needs the original PDF.";

// ---- User-facing copy: image content analysis ----

/**
 * Body copy for an image whose content WAS analysed. Names the two evidence
 * sources and states plainly what the analysis cannot do — it is not a
 * certification of authenticity, and no result from this product ever is.
 */
export const VISION_ANALYSIS_BODY =
  "FraudShield checked this image two ways: EXIF metadata for editing-software and capture-date evidence, and an AI review of the document's content — arithmetic, typography, alignment, and local editing artifacts. A result with no indicators means nothing was found, not that the document has been verified as genuine.";

/**
 * Result-surface line for a content-analysed image that scored in the `clear`
 * bucket. Deliberately does NOT reuse the PDF wording ("consistent with an
 * authentic, software-issued original") — nothing here establishes authenticity.
 */
export const VISION_CLEAR_BODY =
  "No fraud indicators were found in this document's metadata or its content. That is the absence of evidence rather than proof of authenticity — a well-made forgery can leave nothing visible to find.";

// ---- User-facing copy: a scan that returned no signals ----

/**
 * The checks that actually ran, per analysis depth.
 *
 * A clean document is the COMMON case, and it used to render as an empty panel
 * reading "No signal data on this scan — run a fresh scan from your dashboard".
 * That describes a failure, not a successful result: the scan worked and found
 * nothing. Listing what was inspected is the only evidence of work a clean scan
 * can show, and on the result surface it is the entire demonstration of value.
 *
 * Wording follows the rule in this module's header — these say what was
 * INSPECTED, never that the document is genuine.
 */
export const CHECKS_PERFORMED: Record<AnalysisMode, ReadonlyArray<string>> = {
  full_pdf: [
    "Producer and creator software fingerprinting",
    "Creation and modification timeline consistency",
    "Editable form fields left live in the document",
    "Known fraud-template matching",
    // Listed because it now runs. Omitting it would understate the scan, and
    // this list is the only evidence of work a clean result can show.
    "AI content review — arithmetic, typography, alignment, editing artifacts",
  ],
  full_image: [
    "EXIF capture date and editing-software traces",
    "Stripped or missing metadata",
    "AI content review — arithmetic, typography, alignment, editing artifacts",
  ],
  partial: [
    "EXIF capture date and editing-software traces",
    "Stripped or missing metadata",
  ],
};

/** Heading for a completed scan that produced no signals. */
export const NO_INDICATORS_TITLE = "No fraud indicators found";

/**
 * Body for the no-signals result. Holds the same line as VISION_CLEAR_BODY:
 * absence of evidence, never a clean bill of health.
 */
export const NO_INDICATORS_BODY =
  "Every check below ran and returned nothing. That is the absence of evidence rather than proof of authenticity — a well-made forgery can leave nothing to find.";

// ---- Privacy disclosure ----

/**
 * Shown before upload, because uploading is the point of consent. Documents
 * are sent to a third-party AI service (Anthropic) for the content pass; the
 * user has to know that before the file leaves their machine, not after.
 *
 * THIS LINE CHANGED WITH THE PDF CONTENT PASS and had to. It previously read
 * "PDFs are analyzed on our servers", which was true while PDFs got metadata
 * forensics only. Routing them through the content pass makes that sentence
 * false, and a false sentence here is not a copy nit: it is telling a customer
 * their bank statement stays with us while sending it to a third party. If the
 * content pass is ever made conditional, this has to say so.
 */
export const AI_PRIVACY_DISCLOSURE =
  "Every document you upload — images and PDFs alike — is sent to Anthropic's Claude API for AI content analysis. No document is stored by FraudShield after the scan, only the extracted metadata and the resulting signals.";
