import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
//
// The Anthropic SDK and sharp are the only two I/O boundaries in vision.ts.
// `create` is reassigned per test so each case controls exactly one API
// response; sharp is stubbed to the chain vision.ts calls so no real image
// decoding happens.
// ---------------------------------------------------------------------------

// vi.hoisted: vi.mock is hoisted above module scope, so the factory below
// cannot close over a plain const declared here.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    rotate: () => ({
      resize: () => ({
        jpeg: () => ({
          toBuffer: async () => Buffer.from("downscaled-jpeg-bytes"),
        }),
      }),
    }),
  })),
}));

import {
  analyzeDocumentForFraud,
  applyVisionSignals,
  VISION_MODEL,
  MAX_IMAGE_EDGE,
} from "./vision";
import { computeFraudScore, type ScoringInput } from "./score";

const IMAGE = Buffer.from("raw-upload-bytes");

/** Shape of a successful structured-output response. */
function apiResponse(payload: unknown, stopReason = "end_turn") {
  return {
    stop_reason: stopReason,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

/** Baseline metadata-only result for an image with no EXIF findings. */
function baseResult() {
  const input: ScoringInput = {
    metadata: {
      // Deliberately keyword-free: the filename detector would otherwise add
      // weight and obscure what the vision signals contribute.
      filename: "scan-2026-03.jpg",
      mime: "image/jpeg",
      size: 400_000,
      exif_present: true,
    },
    doc_type: "pay_stub",
  };
  return computeFraudScore(input);
}

beforeEach(() => {
  create.mockReset();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("analyzeDocumentForFraud — indicators found", () => {
  it("returns normalized signals and marks the scan analyzed", async () => {
    create.mockResolvedValue(
      apiResponse({
        outcome: "fraud_indicators",
        signals: [
          {
            id: "arithmetic_mismatch",
            label: "Net pay does not reconcile with gross minus deductions",
            severity: "fraud",
            detail:
              "Gross 4,200.00 less deductions 812.35 is 3,387.65, but the net pay field reads 3,900.00.",
            weight: 30,
          },
        ],
      }),
    );

    const result = await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg");

    expect(result.status).toBe("analyzed");
    expect(result.analyzed).toBe(true);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      // Namespaced so a content finding is traceable to the vision module.
      id: "vision_arithmetic_mismatch",
      severity: "fraud",
      weight: 30,
    });
  });

  it("sends the configured model, a downscaled JPEG, and the structured-output schema", async () => {
    create.mockResolvedValue(
      apiResponse({ outcome: "no_indicators", signals: [] }),
    );

    await analyzeDocumentForFraud(IMAGE, "bank_statement", "image/jpeg");

    const [body] = create.mock.calls[0];
    expect(body.model).toBe(VISION_MODEL);
    expect(body.output_config.format.type).toBe("json_schema");

    // The image block carries the sharp output, not the raw upload — the
    // downscale to MAX_IMAGE_EDGE is what keeps per-image tokens ~1.6k
    // instead of ~4.8k.
    const image = body.messages[0].content[0];
    expect(image.type).toBe("image");
    expect(image.source.media_type).toBe("image/jpeg");
    expect(Buffer.from(image.source.data, "base64").toString()).toBe(
      "downscaled-jpeg-bytes",
    );
    expect(MAX_IMAGE_EDGE).toBe(1568);
  });

  it("clamps an over-weighted signal and drops malformed entries", async () => {
    create.mockResolvedValue(
      apiResponse({
        outcome: "fraud_indicators",
        signals: [
          {
            id: "font inconsistency!",
            label: "Font changes mid-amount",
            severity: "suspect",
            detail: "The cents digits in the net pay field use a different typeface.",
            weight: 999,
          },
          // No detail — unrenderable, must be dropped rather than shown blank.
          { id: "x", label: "Something", severity: "fraud", weight: 20 },
        ],
      }),
    );

    const result = await analyzeDocumentForFraud(IMAGE, "invoice", "image/jpeg");

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].weight).toBe(35);
    expect(result.signals[0].id).toBe("vision_font_inconsistency_");
  });
});

describe("analyzeDocumentForFraud — no determination available", () => {
  it("treats a refusal as unavailable without reading content", async () => {
    // A refusal returns HTTP 200 with an empty content array. Reading
    // content[0].text here would throw — the stop_reason check has to come
    // first, and the outcome is inconclusive, never a fraud finding.
    create.mockResolvedValue({ stop_reason: "refusal", content: [] });

    const result = await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg");

    expect(result.status).toBe("unavailable");
    expect(result.analyzed).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("swallows an API error so the scan is never blocked", async () => {
    create.mockRejectedValue(new Error("connection timed out"));

    await expect(analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg")).resolves.toEqual({
      status: "unavailable",
      analyzed: false,
      signals: [],
    });
  });

  it("does not call the API at all when no key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const result = await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg");

    expect(create).not.toHaveBeenCalled();
    expect(result.analyzed).toBe(false);
  });

  it("reports an inconclusive verdict as its own status, not as analyzed", async () => {
    create.mockResolvedValue(
      apiResponse({ outcome: "inconclusive", signals: [] }),
    );

    const result = await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg");

    // Inconclusive means the model looked and could not tell — that is not a
    // complete analysis, so the scan stays partial.
    expect(result.status).toBe("inconclusive");
    expect(result.analyzed).toBe(false);
  });

  it("falls back when the response is not parseable JSON", async () => {
    create.mockResolvedValue({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "not json" }],
    });

    expect((await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg")).analyzed).toBe(false);
  });
});

describe("applyVisionSignals", () => {
  it("adds vision weight to the metadata score and re-derives severity", async () => {
    const base = baseResult();
    expect(base.score).toBe(0);
    expect(base.severity).toBe("clear");

    const merged = applyVisionSignals(base, [
      {
        id: "vision_arithmetic_mismatch",
        label: "Net pay does not reconcile",
        severity: "fraud",
        detail: "Gross minus deductions does not equal the stated net.",
        weight: 30,
      },
      {
        id: "vision_font_inconsistency",
        label: "Font changes mid-amount",
        severity: "suspect",
        detail: "The cents digits use a different typeface.",
        weight: 15,
      },
    ]);

    expect(merged.score).toBe(45);
    expect(merged.severity).toBe("suspect");
    expect(merged.signals).toHaveLength(base.signals.length + 2);
  });

  it("returns the base result untouched when there are no vision signals", () => {
    const base = baseResult();
    expect(applyVisionSignals(base, [])).toBe(base);
  });

  it("clamps the combined score at 100", () => {
    const base = baseResult();
    const merged = applyVisionSignals(base, [
      { id: "a", label: "A", severity: "fraud", detail: "d", weight: 35 },
      { id: "b", label: "B", severity: "fraud", detail: "d", weight: 35 },
      { id: "c", label: "C", severity: "fraud", detail: "d", weight: 35 },
      { id: "d", label: "D", severity: "fraud", detail: "d", weight: 35 },
    ]);

    expect(merged.score).toBe(100);
    expect(merged.severity).toBe("fraud");
  });
});

// ---------------------------------------------------------------------------
// PDFs reach the content pass.
//
// Added with the fix for the accuracy gate (#49). Before it, /api/scan sent
// only images here and PDFs were scored on metadata alone -- 0 of 20 forged
// PDFs detected, scores a constant per document type, genuine and tampered
// indistinguishable. These pin the two halves of the fix: a PDF is sent as a
// document block rather than rasterized, and it is told the truth about what
// it is looking at.
// ---------------------------------------------------------------------------
describe("analyzeDocumentForFraud — PDFs", () => {
  const PDF = Buffer.from("%PDF-1.7 raw-pdf-bytes");

  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    create.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  function sentBlocks() {
    return create.mock.calls[0][0].messages[0].content;
  }

  it("sends a PDF as a document block, not an image", async () => {
    create.mockResolvedValue(apiResponse({ outcome: "no_indicators", signals: [] }));

    await analyzeDocumentForFraud(PDF, "pay_stub", "application/pdf");

    const block = sentBlocks()[0];
    expect(block.type).toBe("document");
    expect(block.source.media_type).toBe("application/pdf");
    // The ORIGINAL bytes, not a re-encode. Rasterizing would discard the text
    // layer and need a system dependency sharp cannot provide.
    expect(block.source.data).toBe(PDF.toString("base64"));
  });

  it("does not route a PDF through the image downscaler", async () => {
    const sharp = (await import("sharp")).default as unknown as ReturnType<typeof vi.fn>;
    (sharp as ReturnType<typeof vi.fn>).mockClear();
    create.mockResolvedValue(apiResponse({ outcome: "no_indicators", signals: [] }));

    await analyzeDocumentForFraud(PDF, "pay_stub", "application/pdf");

    // sharp cannot decode a PDF at all; reaching it would mean every PDF
    // silently failed to be analysed.
    expect(sharp).not.toHaveBeenCalled();
  });

  it("still sends an image as an image block", async () => {
    create.mockResolvedValue(apiResponse({ outcome: "no_indicators", signals: [] }));

    await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/png");

    const block = sentBlocks()[0];
    expect(block.type).toBe("image");
    expect(block.source.media_type).toBe("image/jpeg");
  });

  // FALSE CONTEXT IS NOT A STYLE PROBLEM. The image prompt states the file was
  // downscaled and re-encoded and warns against reading compression artifacts.
  // Telling a model that about a PDF invites findings about things which cannot
  // be present in one.
  it("does not tell the model a PDF was photographed or downscaled", async () => {
    create.mockResolvedValue(apiResponse({ outcome: "no_indicators", signals: [] }));

    await analyzeDocumentForFraud(PDF, "pay_stub", "application/pdf");

    const system: string = create.mock.calls[0][0].system;

    // Matching on the CLAIMS, not on the words. The PDF rule mentions
    // photographs and cameras deliberately -- to say the document is not one
    // and that there is no capture noise to reason about. A blanket word-match
    // would fail on exactly the sentence that makes the prompt correct.
    expect(system).toContain("a PDF of a financial document");
    expect(system).toContain("This is the original PDF, not a photograph");
    expect(system).not.toContain("was downscaled and re-encoded before it reached you");
    expect(system).not.toContain("a photograph or scan of a financial document");
  });

  it("keeps the photography guidance for images", async () => {
    create.mockResolvedValue(apiResponse({ outcome: "no_indicators", signals: [] }));

    await analyzeDocumentForFraud(IMAGE, "pay_stub", "image/jpeg");

    const system: string = create.mock.calls[0][0].system;
    expect(system).toMatch(/photograph/i);
    expect(system).toMatch(/downscaled/i);
  });

  // The guarantee the route depends on: this module never throws, whatever the
  // format. A PDF failure must degrade to the metadata-only result, not 500 a
  // scan the customer has already been charged for.
  it("reports unavailable rather than throwing when the API fails on a PDF", async () => {
    create.mockRejectedValue(new Error("upstream exploded"));

    const result = await analyzeDocumentForFraud(PDF, "pay_stub", "application/pdf");

    expect(result.analyzed).toBe(false);
    expect(result.status).toBe("unavailable");
    expect(result.signals).toEqual([]);
  });
});
