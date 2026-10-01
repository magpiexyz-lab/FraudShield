/**
 * Content-level fraud analysis for image uploads — Claude Opus 5 vision.
 *
 * Why this exists: once a document has been photographed or screenshotted, its
 * metadata describes the *capture*, not the document. The EXIF detectors in
 * ./score.ts can still catch an editor fingerprint or a manipulated capture
 * date, but they cannot see the document itself. What is left to check is the
 * content — arithmetic that does not reconcile, baselines that do not line up,
 * fonts that change mid-field, values that are not plausible for the document
 * type. That is what this module asks a vision model to look at.
 *
 * Three hard rules, in order of priority:
 *
 *   1. It NEVER certifies a document as real. There are exactly three outcomes:
 *      fraud indicators found, inconclusive, or no indicators found. "No
 *      indicators found" is the absence of evidence, not evidence of absence,
 *      and every copy path built on this module has to say so.
 *   2. It never blocks a scan. Missing key, timeout, HTTP error, refusal,
 *      unparseable response, undecodable image — every one of them returns an
 *      unanalyzed result and the scan falls back to the metadata-only partial
 *      analysis. This module does not throw.
 *   3. Documents leave our infrastructure here. The image is sent to Anthropic.
 *      That has to be disclosed to the user before they upload — see
 *      AI_PRIVACY_DISCLOSURE in ./analysis-mode.ts.
 *
 * Cost: images are downscaled to a 1568px long edge before sending. Opus 5
 * accepts up to 2576px, but a full-resolution page runs ~4,784 input tokens
 * against ~1,600 at 1568px, and a document photograph does not need the extra
 * fidelity for the checks below.
 */

import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import type { FraudSignal } from "@/lib/types";
import { computeScore, scoreSeverity, type ScoringResult } from "@/lib/fraud/score";

// ---- Tunables ----

/** Vision model. Structured outputs + high-resolution vision. */
export const VISION_MODEL = "claude-opus-5";

/** Long-edge cap, in pixels, applied before the image is sent. */
export const MAX_IMAGE_EDGE = 1568;

/** Wall-clock budget for the whole vision call. Past this we fall back. */
export const VISION_TIMEOUT_MS = 25_000;

/** Ceiling on how much a single vision signal can move the score. */
const MAX_SIGNAL_WEIGHT = 35;

/** Ceiling on how many signals we accept from one response. */
const MAX_SIGNALS = 6;

// ---- Public types ----

/**
 * What happened on the content pass. Persisted on `file_meta.vision_status`
 * so the result surface can say which of these it is looking at.
 *
 *   analyzed     — the model returned a usable determination (indicators found
 *                  or none found). Only this state upgrades a scan to full.
 *   inconclusive — the model looked and could not tell (unreadable photo, not
 *                  a financial document, too cropped).
 *   unavailable  — the pass did not complete: no key, timeout, API error,
 *                  refusal, undecodable image, or a malformed response.
 */
export type VisionStatus = "analyzed" | "inconclusive" | "unavailable";

export type VisionResult = {
  status: VisionStatus;
  /** True only when status === "analyzed". Convenience for the route. */
  analyzed: boolean;
  /** Content-level signals, in the same shape the scoring engine emits. */
  signals: FraudSignal[];
};

/** Result shape when the content pass produced nothing usable. */
function unusable(status: Exclude<VisionStatus, "analyzed">): VisionResult {
  return { status, analyzed: false, signals: [] };
}

// ---- Structured output contract ----

// Constrains the model to the FraudSignal shape the rest of the app already
// renders and scores, so a vision finding is indistinguishable from a metadata
// finding at the UI layer.
//
// `severity` deliberately omits "clear": there is no such thing as a signal
// that asserts authenticity. A document with nothing wrong produces an empty
// signals array, not a reassuring signal.
const VISION_SCHEMA = {
  type: "object",
  properties: {
    outcome: {
      type: "string",
      enum: ["fraud_indicators", "no_indicators", "inconclusive"],
      description:
        "fraud_indicators: at least one concrete indicator of fabrication or alteration. no_indicators: the document was legible and you found nothing wrong. inconclusive: you could not assess it (unreadable, cropped, not a financial document).",
    },
    signals: {
      type: "array",
      description:
        "One entry per concrete indicator. Empty unless outcome is fraud_indicators.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "snake_case identifier for the indicator type, e.g. arithmetic_mismatch, font_inconsistency.",
          },
          label: {
            type: "string",
            description: "Short human-readable name of the finding, under 60 characters.",
          },
          severity: {
            type: "string",
            enum: ["suspect", "fraud"],
            description:
              "fraud: this alone is strong evidence of fabrication. suspect: warrants manual review.",
          },
          detail: {
            type: "string",
            description:
              "What you saw and where on the document you saw it. Quote the specific values or field names. State it as an observation, not a conclusion about the person.",
          },
          weight: {
            type: "integer",
            description:
              "Contribution to a 0-100 fraud score. 10-15 minor, 20-30 significant, 31-35 decisive. Never exceed 35.",
          },
        },
        required: ["id", "label", "severity", "detail", "weight"],
        additionalProperties: false,
      },
    },
  },
  required: ["outcome", "signals"],
  additionalProperties: false,
} as const;

// THE PROMPT IS FORMAT-SPECIFIC, and has to be. A PDF was not photographed,
// was not downscaled, and carries no camera artefacts; telling the model
// otherwise is false, and false context is not a stylistic problem — it invites
// findings about things that cannot be present, and suppresses the pixel-level
// reasoning that IS available on a photo. The two halves below are the only
// parts that differ; everything in SYSTEM_PROMPT_CORE applies to both.
const IMAGE_FRAMING = `a photograph or scan of a financial document`;
const PDF_FRAMING = `a PDF of a financial document, with its text and layout intact`;

const IMAGE_ARTIFACT_RULE = `- Ordinary photography artifacts: page skew, glare, shadow, moiré, camera blur affecting the whole image, or JPEG blocking that is uniform across the page. This image was downscaled and re-encoded before it reached you, so pixel-level compression forensics are not available to you — do not report them.`;
const PDF_ARTIFACT_RULE = `- Rendering differences that are not evidence: antialiasing, subpixel positioning, or font substitution for a font the document did not embed. This is the original PDF, not a photograph, so there are no capture artifacts to interpret and no camera noise to compare — do not reason about either.`;

const IMAGE_UNREADABLE_RULE = `- If the image is unreadable, heavily cropped, or is not a financial document, return inconclusive with no signals.`;
const PDF_UNREADABLE_RULE = `- If the PDF is empty, is a scan embedded in a PDF wrapper that you cannot read, or is not a financial document, return inconclusive with no signals.`;

const IMAGE_UNSURE_RULE = `- Report only what you can point to. If you are unsure whether something is an indicator or an artifact of the photograph, leave it out.`;
const PDF_UNSURE_RULE = `- Report only what you can point to. If you are unsure whether something is an indicator or a consequence of how the PDF was generated, leave it out.`;

const SYSTEM_PROMPT = (framing: string) =>
  `You are a document forensics analyst examining ${framing} submitted for verification.

The document's metadata has already been analyzed separately. Your job is the content: what is visible on the document itself.

Look for:
- Arithmetic that does not reconcile (gross minus deductions not equal to net, line items not summing to a stated total, YTD figures inconsistent with the pay period, tax withholding implausible for the stated gross).
- Typographic inconsistency within a field or column: font, weight, size, or letterform changes between characters that should have been rendered by the same system, especially in amounts.
- Alignment and baseline breaks: a figure sitting off the row's baseline, a column whose digits do not share a decimal alignment, spacing that differs from the surrounding table.
- Local editing artifacts: halos or blur around a number, background texture that stops at a rectangle, a patch whose sharpness or noise differs from the region around it, cloned or repeated areas.
- Structural implausibility for the document type: missing issuer identifiers, date formats that vary within one document, a period that does not match the dates shown, placeholder or template text left in place, a layout that does not match how the named issuer's system produces this document.

Do not report:
- Anything you can only infer from metadata rather than see.
- Judgments about the person or their finances. Round numbers, a low income, or an unfamiliar employer are not fraud indicators.
ARTIFACT_RULE

Rules on your verdict:
- You have exactly three outcomes: fraud_indicators, inconclusive, no_indicators.
- You must NEVER certify a document as genuine, real, verified, or authentic. no_indicators means only that you found nothing wrong in what you could see — it is not a statement that the document is real, and you must not phrase it as one.
UNSURE_RULE
UNREADABLE_RULE
- If the document is legible and nothing above applies, return no_indicators with no signals. An honest empty result is the correct answer for a document with nothing wrong; do not manufacture a finding.`;

/** The system prompt for one format. */
function systemPromptFor(mime: string): string {
  const isPdf = mime === "application/pdf";
  return SYSTEM_PROMPT(isPdf ? PDF_FRAMING : IMAGE_FRAMING)
    .replace("ARTIFACT_RULE", isPdf ? PDF_ARTIFACT_RULE : IMAGE_ARTIFACT_RULE)
    .replace("UNSURE_RULE", isPdf ? PDF_UNSURE_RULE : IMAGE_UNSURE_RULE)
    .replace("UNREADABLE_RULE", isPdf ? PDF_UNREADABLE_RULE : IMAGE_UNREADABLE_RULE);
}

// ---- Image preparation ----

/**
 * Downscale to the long-edge cap and normalize to JPEG.
 *
 * `rotate()` with no argument applies the EXIF orientation tag, so a phone
 * photo reaches the model the way a human would see it. Returns null for
 * anything sharp cannot decode (HEIC is the common case — the prebuilt binaries
 * ship without HEIF support), which routes the scan to the partial fallback.
 */
async function prepareImage(buf: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(buf)
      .rotate()
      .resize({
        width: MAX_IMAGE_EDGE,
        height: MAX_IMAGE_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}

// ---- Response handling ----

type RawSignal = {
  id?: unknown;
  label?: unknown;
  severity?: unknown;
  detail?: unknown;
  weight?: unknown;
};

/** Trim a model-authored string to a length the UI can render safely. */
function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Coerce the model's signals into FraudSignal, dropping anything malformed.
 *
 * The schema already constrains the shape; this enforces the parts a JSON
 * schema cannot (numeric bounds, string lengths, list length) and guarantees
 * the score cannot be moved by an out-of-range weight.
 */
function normalizeSignals(raw: unknown): FraudSignal[] {
  if (!Array.isArray(raw)) return [];

  const signals: FraudSignal[] = [];
  for (const entry of raw.slice(0, MAX_SIGNALS) as RawSignal[]) {
    if (!entry || typeof entry !== "object") continue;

    const label = text(entry.label, 120);
    const detail = text(entry.detail, 600);
    if (!label || !detail) continue;

    const id = text(entry.id, 60).replace(/[^a-z0-9_]/gi, "_").toLowerCase();
    const severity = entry.severity === "fraud" ? "fraud" : "suspect";
    const weight = Math.max(
      0,
      Math.min(MAX_SIGNAL_WEIGHT, Math.round(Number(entry.weight) || 0)),
    );

    signals.push({
      // Namespaced so a content finding is traceable to this module in the
      // stored signals array.
      id: `vision_${id || "content_indicator"}`,
      label,
      severity,
      detail,
      weight,
    });
  }
  return signals;
}

/** Pull the structured-output JSON out of the response's text block. */
function parseResponse(content: Anthropic.ContentBlock[]): VisionResult {
  const block = content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!block) return unusable("unavailable");

  let parsed: { outcome?: unknown; signals?: unknown };
  try {
    parsed = JSON.parse(block.text) as { outcome?: unknown; signals?: unknown };
  } catch {
    return unusable("unavailable");
  }

  if (parsed.outcome === "inconclusive") return unusable("inconclusive");

  if (parsed.outcome === "fraud_indicators") {
    const signals = normalizeSignals(parsed.signals);
    // An indicators verdict with nothing behind it is not a determination we
    // can show or score — treat it as inconclusive rather than inventing one.
    if (signals.length === 0) return unusable("inconclusive");
    return { status: "analyzed", analyzed: true, signals };
  }

  if (parsed.outcome === "no_indicators") {
    return { status: "analyzed", analyzed: true, signals: [] };
  }

  return unusable("unavailable");
}

// ---- Entry point ----

/**
 * Build the content block that carries the document to the model.
 *
 * PDFs go as a `document` block, NOT rasterized first. sharp cannot decode a
 * PDF at all, and adding poppler or pdfjs to do it would mean a system
 * dependency on a serverless runtime for no gain: the API accepts PDFs
 * directly (Base64PDFSource in the SDK's messages types), and it keeps the
 * selectable text rather than flattening a document to pixels.
 *
 * Images keep the existing path: downscale, apply EXIF orientation, normalize
 * to JPEG. That conversion is what makes the hardcoded image/jpeg media type
 * below correct for a PNG or HEIC upload.
 */
async function documentContentBlock(
  buf: Buffer,
  mime: string,
): Promise<Anthropic.ContentBlockParam | null> {
  if (mime === "application/pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: buf.toString("base64"),
      },
    };
  }

  const image = await prepareImage(buf);
  if (!image) return null;
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: image.toString("base64"),
    },
  };
}

/**
 * Run the content pass on an uploaded document.
 *
 * PDFS REACH THIS TOO, as of the accuracy gate (#49). They did not before, and
 * the measurement is why: scored on metadata alone, the product caught 0 of 20
 * forged PDFs, because an edited salary or a falsified balance is simply never
 * read. The scores were a constant per document type — identical for genuine
 * and forged — which is what a detector looks like when it is not examining
 * the thing it claims to examine.
 *
 * Never throws. Every failure path returns an unanalyzed result, and the caller
 * keeps whatever the metadata detectors already produced.
 *
 * @param buf      Raw uploaded bytes (not persisted anywhere).
 * @param docType  Document type, for context in the prompt.
 * @param mime     Server-detected MIME; selects the content block.
 */
export async function analyzeDocumentForFraud(
  buf: Buffer,
  docType: "pay_stub" | "bank_statement" | "invoice",
  mime: string,
): Promise<VisionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return unusable("unavailable");

  const block = await documentContentBlock(buf, mime);
  if (!block) return unusable("unavailable");

  try {
    const client = new Anthropic({
      apiKey,
      timeout: VISION_TIMEOUT_MS,
      // One retry only. A scan is a foreground request — a long retry ladder
      // costs the user more than the partial fallback does.
      maxRetries: 1,
    });

    const response = await client.messages.create(
      {
        model: VISION_MODEL,
        max_tokens: 4096,
        system: systemPromptFor(mime),
        output_config: {
          // Low effort: this is a foreground request and the task is bounded
          // observation, not open-ended reasoning.
          effort: "low",
          format: { type: "json_schema", schema: VISION_SCHEMA },
        },
        messages: [
          {
            role: "user",
            content: [
              block,
              {
                type: "text",
                // "document" rather than "image": the same prompt now covers a
                // PDF, and telling the model it is looking at an image when it
                // is not invites it to comment on capture artefacts that
                // cannot exist.
                text: `This document was submitted as a ${docType.replace("_", " ")}. Examine its content and return your findings.`,
              },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(VISION_TIMEOUT_MS) },
    );

    // Checked BEFORE content is read: on a refusal the content array is empty
    // or partial, and indexing into it would throw. A refusal is not a fraud
    // finding and must not be scored as one — it is simply inconclusive.
    if (response.stop_reason === "refusal") return unusable("unavailable");

    return parseResponse(response.content);
  } catch {
    // Timeout, network failure, 4xx/5xx, malformed SDK response — all identical
    // from the scan's point of view: no content determination is available.
    return unusable("unavailable");
  }
}

// ---- Score integration ----

/**
 * Fold vision signals into an existing metadata-only scoring result.
 *
 * Uses the same weight-sum-and-clamp the scoring engine uses, so a vision
 * finding and a metadata finding contribute identically and the persisted
 * score stays consistent with `computeFraudScore`.
 */
export function applyVisionSignals(
  base: ScoringResult,
  visionSignals: FraudSignal[],
): ScoringResult {
  if (visionSignals.length === 0) return base;

  const signals = [...base.signals, ...visionSignals];
  const score = computeScore(signals.reduce((sum, s) => sum + s.weight, 0));

  return { score, signals, severity: scoreSeverity(score) };
}
