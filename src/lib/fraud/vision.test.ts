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
  analyzeImageForFraud,
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

describe("analyzeImageForFraud — indicators found", () => {
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

    const result = await analyzeImageForFraud(IMAGE, "pay_stub");

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

    await analyzeImageForFraud(IMAGE, "bank_statement");

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

    const result = await analyzeImageForFraud(IMAGE, "invoice");

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].weight).toBe(35);
    expect(result.signals[0].id).toBe("vision_font_inconsistency_");
  });
});

describe("analyzeImageForFraud — no determination available", () => {
  it("treats a refusal as unavailable without reading content", async () => {
    // A refusal returns HTTP 200 with an empty content array. Reading
    // content[0].text here would throw — the stop_reason check has to come
    // first, and the outcome is inconclusive, never a fraud finding.
    create.mockResolvedValue({ stop_reason: "refusal", content: [] });

    const result = await analyzeImageForFraud(IMAGE, "pay_stub");

    expect(result.status).toBe("unavailable");
    expect(result.analyzed).toBe(false);
    expect(result.signals).toEqual([]);
  });

  it("swallows an API error so the scan is never blocked", async () => {
    create.mockRejectedValue(new Error("connection timed out"));

    await expect(analyzeImageForFraud(IMAGE, "pay_stub")).resolves.toEqual({
      status: "unavailable",
      analyzed: false,
      signals: [],
    });
  });

  it("does not call the API at all when no key is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    const result = await analyzeImageForFraud(IMAGE, "pay_stub");

    expect(create).not.toHaveBeenCalled();
    expect(result.analyzed).toBe(false);
  });

  it("reports an inconclusive verdict as its own status, not as analyzed", async () => {
    create.mockResolvedValue(
      apiResponse({ outcome: "inconclusive", signals: [] }),
    );

    const result = await analyzeImageForFraud(IMAGE, "pay_stub");

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

    expect((await analyzeImageForFraud(IMAGE, "pay_stub")).analyzed).toBe(false);
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
