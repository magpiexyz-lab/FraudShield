import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  analysisMode,
  isFullAnalysis,
  LIMITED_ANALYSIS_TITLE,
  LIMITED_ANALYSIS_BODY,
  VISION_ANALYSIS_BODY,
  VISION_CLEAR_BODY,
  AI_PRIVACY_DISCLOSURE,
} from "./analysis-mode";
import { computeFraudScore, type ScoringInput } from "./score";

// The `clear` bucket ceiling in score.ts / scan-result/severity.ts. A document
// whose *maximum reachable* score cannot exceed this is an arithmetically
// guaranteed "clear" verdict — i.e. a guaranteed false negative.
const CLEAR_MAX = 33;

describe("isFullAnalysis", () => {
  it("returns true for application/pdf", () => {
    expect(isFullAnalysis({ mime: "application/pdf" })).toBe(true);
    expect(analysisMode({ mime: "application/pdf" })).toBe("full_pdf");
  });

  it.each(["image/png", "image/jpeg", "image/webp", "image/heic"])(
    "returns false for image mime %s when the content pass did not complete",
    (mime) => {
      expect(isFullAnalysis({ mime })).toBe(false);
      expect(isFullAnalysis({ mime, vision_analyzed: false })).toBe(false);
    },
  );

  it.each(["image/png", "image/jpeg", "image/webp", "image/heic"])(
    "returns true for image mime %s once the AI content pass produced a determination",
    (mime) => {
      expect(isFullAnalysis({ mime, vision_analyzed: true })).toBe(true);
      expect(analysisMode({ mime, vision_analyzed: true })).toBe("full_image");
    },
  );

  it.each(["", "application/octet-stream", "text/plain"])(
    "fails safe to limited for unknown mime %s",
    (mime) => {
      expect(isFullAnalysis({ mime })).toBe(false);
      // A vision flag on a non-image mime must not upgrade it — the content
      // pass only ever runs on images.
      expect(isFullAnalysis({ mime, vision_analyzed: true })).toBe(false);
    },
  );

  it("fails safe when file_meta is missing entirely", () => {
    expect(isFullAnalysis(null)).toBe(false);
    expect(isFullAnalysis(undefined)).toBe(false);
    expect(analysisMode(null)).toBe("partial");
  });
});

describe("limited-analysis copy constants", () => {
  it("exports the approved title", () => {
    expect(LIMITED_ANALYSIS_TITLE).toBe("Partial analysis");
  });

  it("exports the approved body", () => {
    expect(LIMITED_ANALYSIS_BODY).toBe(
      "Image files receive metadata checks — editing software, capture date, and stripped or missing EXIF. Full document forensics, including producer fingerprinting and template matching, needs the original PDF.",
    );
  });

  it("does not claim images get only basic checks — they now get EXIF forensics", () => {
    expect(LIMITED_ANALYSIS_BODY.toLowerCase()).not.toContain("only receive basic");
    expect(LIMITED_ANALYSIS_BODY.toLowerCase()).toContain("metadata checks");
  });
});

describe("content-analysis copy", () => {
  // The product must never certify a document as real. A "no indicators"
  // result is the absence of evidence, and the copy has to say so rather than
  // reading as a clean bill of health.
  it.each([
    ["VISION_ANALYSIS_BODY", VISION_ANALYSIS_BODY],
    ["VISION_CLEAR_BODY", VISION_CLEAR_BODY],
  ])("%s never asserts the document is genuine", (_name, copy) => {
    const lower = copy.toLowerCase();
    for (const claim of [
      "is authentic",
      "is genuine",
      "is real",
      "verified as authentic",
      "confirmed authentic",
    ]) {
      expect(lower).not.toContain(claim);
    }
  });

  it("states what a no-indicators result does not mean", () => {
    expect(VISION_ANALYSIS_BODY.toLowerCase()).toContain("not that the document has been verified");
    expect(VISION_CLEAR_BODY.toLowerCase()).toContain("absence of evidence");
  });
});

describe("privacy disclosure", () => {
  it("names the third party documents are sent to", () => {
    expect(AI_PRIVACY_DISCLOSURE).toContain("Anthropic");
  });

  it("states that nothing is retained after the scan", () => {
    expect(AI_PRIVACY_DISCLOSURE.toLowerCase()).toContain("no document is stored");
  });
});

// ---------------------------------------------------------------------------
// Recurrence guard (AC6)
//
// The original defect: /api/scan accepts image mimes, but only extracts deep
// (PDF) metadata for application/pdf — so 7 of the 8 detectors can never fire
// and every image scan is a guaranteed "clear" false negative that the UI
// rendered as a real verdict.
//
// This guard fails if anyone adds a mime to the scan API's accepted list that
// has neither deep checks nor limited-analysis classification. We read the
// route's source (rather than importing it — the module pulls in server-only
// deps) so the guard tracks the real accepted list.
// ---------------------------------------------------------------------------

const ROUTE_PATH = fileURLToPath(
  new URL("../../app/api/scan/route.ts", import.meta.url),
);
const ROUTE_SRC = readFileSync(ROUTE_PATH, "utf-8");

/** Mimes the scan API accepts for upload. */
function parseAcceptedMimes(src: string): string[] {
  const block = /const ACCEPTED_MIME = new Set\(\[([\s\S]*?)\]\)/.exec(src)?.[1];
  if (!block) return [];
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Mimes for which the route actually extracts deep PDF metadata. */
function parseDeepMetadataMimes(src: string): string[] {
  const m = /file\.type === "([^"]+)"\s*\?\s*extractPdfMetadata/.exec(src);
  return m ? [m[1]] : [];
}

/**
 * Mime prefixes for which the route extracts EXIF metadata.
 *
 * Two accepted spellings: the gate inline in the ternary, or the gate hoisted
 * into a named const (the route also reuses it for the AI content pass).
 */
function parseExifMetadataPrefixes(src: string): string[] {
  const inline =
    /file\.type\.startsWith\("([^"]+)"\)\s*\?\s*(?:await\s+)?extractImageMetadata/.exec(
      src,
    );
  if (inline) return [inline[1]];

  const named = /(\w+)\s*\?\s*(?:await\s+)?extractImageMetadata/.exec(src);
  if (!named) return [];
  const decl = new RegExp(
    `const\\s+${named[1]}\\s*=\\s*file\\.type\\.startsWith\\("([^"]+)"\\)`,
  ).exec(src);
  return decl ? [decl[1]] : [];
}

const ACCEPTED_MIMES = parseAcceptedMimes(ROUTE_SRC);
const DEEP_METADATA_MIMES = parseDeepMetadataMimes(ROUTE_SRC);
const EXIF_METADATA_PREFIXES = parseExifMetadataPrefixes(ROUTE_SRC);

/**
 * Worst-case score reachable for a mime, given what the scan route can
 * actually supply to the scoring engine. Every field that could trip a
 * detector is populated, but only the fields the route really extracts for
 * that mime: pdf_* for the deep-metadata mime, exif_* for mimes matching an
 * EXIF prefix. Everything else the route leaves undefined.
 */
function maxReachableScore(mime: string): number {
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const deep = DEEP_METADATA_MIMES.includes(mime);
  const exif = EXIF_METADATA_PREFIXES.some((p) => mime.startsWith(p));
  const input: ScoringInput = {
    metadata: {
      // suspicious filename (+10) and unusually small file (PDF-only, +12)
      filename: "fake-editable-paystub-template",
      mime,
      size: 1_000,
      ...(deep
        ? {
            pdf_producer: "ReportLab / fillpdf", // AI library + fraud template
            pdf_creator: "Canva", // design-tool creator
            pdf_created: future, // future + recently created
            pdf_modified: future, // anomalous modification
            page_count: 1,
          }
        : {}),
      ...(exif
        ? {
            exif_software: "Adobe Photoshop 25.0", // editing software (+30)
            exif_datetime_original: future, // future capture (+35)
            exif_present: true,
          }
        : {}),
    },
    doc_type: "pay_stub",
  };
  return computeFraudScore(input).score;
}

describe("recurrence guard: every accepted mime is classified honestly", () => {
  it("parses a non-empty accepted-mime list from the scan route", () => {
    expect(
      ACCEPTED_MIMES.length,
      `Failed to parse ACCEPTED_MIME out of ${ROUTE_PATH}. The regex no longer matches the route source — update this guard instead of letting it pass vacuously.`,
    ).toBeGreaterThan(0);
  });

  it("parses a non-empty deep-metadata mime list from the scan route", () => {
    expect(
      DEEP_METADATA_MIMES.length,
      `Failed to parse the extractPdfMetadata condition out of ${ROUTE_PATH}. Update this guard instead of letting it pass vacuously.`,
    ).toBeGreaterThan(0);
  });

  it("parses a non-empty EXIF-metadata prefix list from the scan route", () => {
    expect(
      EXIF_METADATA_PREFIXES.length,
      `Failed to parse the extractImageMetadata condition out of ${ROUTE_PATH}. Update this guard instead of letting it pass vacuously.`,
    ).toBeGreaterThan(0);
  });

  it("marks every accepted mime that cannot exceed the 'clear' threshold as limited analysis", () => {
    for (const mime of ACCEPTED_MIMES) {
      const max = maxReachableScore(mime);
      if (max > CLEAR_MAX) continue;
      expect(
        isFullAnalysis({ mime }),
        `Accepted mime "${mime}" has a maximum reachable fraud score of ${max}, which can never exceed the 'clear' threshold (${CLEAR_MAX}) — every scan of this type is a guaranteed false negative. It must be classified as limited analysis (isFullAnalysis({ mime: "${mime}" }) === false), or the scan route must run deep checks for it.`,
      ).toBe(false);
    }
  });
});
