// The scan pipeline: bytes in, score + signals + metadata out.
//
// Extracted from src/app/api/scan/route.ts so the authenticated route and the
// anonymous free-scan surface run the SAME analysis. A second transcription of
// this sequence is how two surfaces start reporting different scores for the
// same document.
//
// Raw file bytes are NEVER persisted — only the derived metadata + signals +
// score leave this function.

import { computeFraudScore } from "@/lib/fraud/score";
import { analyzeDocumentForFraud, applyVisionSignals } from "@/lib/fraud/vision";
import {
  sanitizeFilename,
  inferDocType,
  extractPdfMetadata,
  extractImageMetadata,
  type DocType,
} from "@/lib/scan-intake";
import type { DocumentMetadata, ScoringInput } from "@/lib/fraud/score";
import type { FraudSignal } from "@/lib/types";

export type RunFraudScanInput = {
  /** Raw uploaded bytes. Not persisted anywhere. */
  buf: Buffer;
  /** Raw user-supplied filename — sanitized in here, not by the caller. */
  filename: string;
  /**
   * Server-detected MIME, exactly as the upload reported it. Pass it RAW,
   * including the empty string: the `application/octet-stream` fallback is
   * applied to `metadata.mime` only, and widening it here would change which
   * extractor runs and what the content pass is told.
   */
  mime: string;
  /** When omitted, inferred from the sanitized filename. */
  docType?: DocType;
  /**
   * An already-decoded image (the output of `prepareImage`), forwarded to the
   * content pass so the same bytes are not decoded twice.
   *
   * /api/free-scan decodes above its scan-allowance counters — an undecodable
   * HEIC must not cost a visitor one of their 3 free scans — and hands the
   * result over here. /api/scan passes nothing and decodes inside the content
   * pass exactly as before.
   */
  preparedImage?: Buffer;
};

export type RunFraudScanResult = {
  score: number;
  signals: FraudSignal[];
  metadata: DocumentMetadata;
  vision: Awaited<ReturnType<typeof analyzeDocumentForFraud>>;
  /**
   * The doc type this scan was actually scored as — the caller's override when
   * it gave one, otherwise what was inferred from the sanitized filename.
   *
   * Returned because the caller PERSISTS it (scans.doc_type). Re-deriving it
   * at the call site would put the inference precedence in two places, and the
   * copy that drifts is the one that decides what the row says this document
   * was.
   */
  docType: DocType;
};

/**
 * Sanitize, extract metadata, score, and run the AI content pass.
 *
 * No `severity` is returned on purpose. Callers derive it from `scoreSeverity`
 * in lib/fraud/score.ts — there are already three copies of that threshold and
 * a fourth is how they start to disagree.
 */
export async function runFraudScan(
  input: RunFraudScanInput,
): Promise<RunFraudScanResult> {
  const { buf, filename, mime, docType: docTypeOverride, preparedImage } = input;

  const sanitizedName = sanitizeFilename(filename || "document");
  const docType = docTypeOverride ?? inferDocType(sanitizedName);

  const isImage = mime.startsWith("image/");
  const pdfMeta = mime === "application/pdf" ? extractPdfMetadata(buf) : {};
  const imageMeta = isImage ? await extractImageMetadata(buf) : {};

  const metadata: DocumentMetadata = {
    filename: sanitizedName,
    // The fallback belongs HERE and nowhere else. lib/fraud/analysis-mode.ts
    // reads this field to decide full vs partial analysis, which is what
    // `counts_toward_quota` is written from — an undefined mime would read as
    // partial and silently stop spending quota.
    mime: mime || "application/octet-stream",
    // Byte length of the buffer we actually analysed. Equal to File.size for
    // an upload (the buffer is built from file.arrayBuffer()), and the
    // `unusually_small_file` detector in lib/fraud/score.ts reads it.
    size: buf.byteLength,
    ...pdfMeta,
    ...imageMeta,
  };

  const scoringInput: ScoringInput = { metadata, doc_type: docType };
  let result = computeFraudScore(scoringInput);

  // AI content pass — EVERY supported format, images and PDFs alike.
  //
  //     This used to run on images only, on the reasoning that a PDF already
  //     got document-level forensics. The accuracy gate (#49) measured what
  //     that was worth: 0 of 20 forged PDFs detected, with scores that were a
  //     constant per document type and identical for genuine and tampered.
  //     Metadata forensics cannot see an edited salary, because nothing in
  //     that path ever reads the number. A detector that never examines the
  //     document cannot be tuned into one that does.
  //
  //     analyzeDocumentForFraud never throws: on a missing key, timeout, API
  //     error, refusal, or inconclusive verdict it reports back unanalyzed and
  //     the scan keeps whatever the metadata detectors produced.
  //     `preparedImage` is undefined for /api/scan, which leaves the decode
  //     where it has always been — inside the content pass.
  const vision = await analyzeDocumentForFraud(buf, docType, mime, preparedImage);
  metadata.vision_status = vision.status;
  if (vision.analyzed) {
    // Only a completed determination upgrades the scan to a full analysis
    // (see lib/fraud/analysis-mode.ts).
    metadata.vision_analyzed = true;
    result = applyVisionSignals(result, vision.signals);
  }

  const { score, signals } = result;
  return { score, signals, metadata, vision, docType };
}
