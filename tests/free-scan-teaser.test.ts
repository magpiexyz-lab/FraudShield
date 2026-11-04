// Which two forensic signals the anonymous free scan is allowed to show.
//
// WHY THIS EXISTS. The free panel shows a score plus the first two signals and
// teases the rest behind signup. The obvious implementation of "the first two"
// is signals.slice(0, 2), and that is a defect rather than a shortcut:
//
//   - applyVisionSignals (src/lib/fraud/vision.ts:500) returns
//     [...base.signals, ...visionSignals], so the AI content findings are
//     always LAST in the array.
//   - SignalBreakdown (src/app/scan-result/signal-breakdown.tsx) sorts by
//     severity, but only after it receives props -- slicing upstream of it
//     defeats that sort entirely.
//
// So slice(0, 2) shows two metadata rows and ALWAYS withholds the AI finding.
// Metadata-only scoring detected 0 of 20 forged PDFs (see the comment in
// src/app/api/scan/route.ts), so the free panel would print a confident
// "87 / Likely forged" above two innocuous low-weight rows -- the worst
// possible outcome for a surface whose entire job is proving that a real scan
// beats a canned animation.
//
// selectTeaserSignals is pure and total: no I/O, no randomness, no Date.
// vitest runs environment "node" here -- nothing in this file renders React.

import { describe, it, expect } from "vitest";

import type { FraudSignal } from "@/lib/types";
import { selectTeaserSignals } from "@/lib/free-scan-teaser";

function sig(
  id: string,
  severity: FraudSignal["severity"],
  weight: number,
): FraudSignal {
  return {
    id,
    label: `Label for ${id}`,
    severity,
    detail: `Detail for ${id}`,
    weight,
  };
}

const ids = (signals: FraudSignal[]) => signals.map((s) => s.id);

describe("selectTeaserSignals", () => {
  it("keeps an AI signal even when metadata signals out-rank it", () => {
    // THE HEADLINE CASE -- the one assertion this whole module exists for.
    // Vision signals arrive last and are the lowest-weighted here, exactly as
    // a real image scan produces them. A plain signals.slice(0, 2) returns
    // [missing_pdf_metadata, recently_created] and FAILS this test.
    const input = [
      sig("missing_pdf_metadata", "suspect", 25),
      sig("recently_created", "suspect", 20),
      sig("vision_inconsistent_font_rendering", "suspect", 10),
    ];

    const result = selectTeaserSignals(input);

    expect(result).toHaveLength(2);
    expect(result.some((s) => s.id.startsWith("vision_"))).toBe(true);
    // Rule 3 displaces only the LOWER-ranked metadata signal, never the top one.
    expect(ids(result)).toEqual([
      "vision_inconsistent_font_rendering",
      "missing_pdf_metadata",
    ]);
  });

  it("ranks fraud above suspect above clear", () => {
    const input = [
      sig("missing_exif_metadata", "clear", 90),
      sig("suspicious_filename", "suspect", 80),
      sig("known_fraud_template_producer", "fraud", 1),
    ];

    // Weight is deliberately inverted against severity: severity wins.
    expect(ids(selectTeaserSignals(input))).toEqual([
      "known_fraud_template_producer",
      "suspicious_filename",
    ]);
  });

  it("orders by descending weight within a single severity", () => {
    const input = [
      sig("unusually_small_file", "suspect", 5),
      sig("anomalous_modification", "suspect", 30),
      sig("future_date", "suspect", 20),
    ];

    expect(ids(selectTeaserSignals(input))).toEqual([
      "anomalous_modification",
      "future_date",
    ]);
  });

  it("returns at most n signals", () => {
    const input = [
      sig("a_one", "fraud", 30),
      sig("a_two", "fraud", 20),
      sig("a_three", "fraud", 10),
      sig("vision_x", "fraud", 40),
    ];

    expect(selectTeaserSignals(input, 1)).toHaveLength(1);
    expect(selectTeaserSignals(input, 2)).toHaveLength(2);
    expect(selectTeaserSignals(input, 3)).toHaveLength(3);
  });

  it("returns [] for n = 0 and for negative n", () => {
    const input = [sig("vision_x", "fraud", 40), sig("a_one", "fraud", 30)];

    expect(selectTeaserSignals(input, 0)).toEqual([]);
    expect(selectTeaserSignals(input, -1)).toEqual([]);
  });

  it("returns [] for an empty input", () => {
    expect(selectTeaserSignals([])).toEqual([]);
    expect(selectTeaserSignals([], 5)).toEqual([]);
  });

  it("does not repeat a vision signal that is already the top-ranked signal", () => {
    // Rule 3 takes the best vision signal first; the fill pass must not then
    // pick the same signal again out of the merged ranking.
    const input = [
      sig("vision_template_mismatch", "fraud", 40),
      sig("recently_created", "suspect", 10),
    ];

    const result = selectTeaserSignals(input);

    expect(ids(result)).toEqual([
      "vision_template_mismatch",
      "recently_created",
    ]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("returns a lone vision signal once, not padded by repetition", () => {
    const input = [sig("vision_only", "fraud", 40)];

    const result = selectTeaserSignals(input, 2);

    expect(result).toHaveLength(1);
    expect(ids(result)).toEqual(["vision_only"]);
  });

  it("does not mutate the input array", () => {
    const input = [
      sig("missing_pdf_metadata", "clear", 5),
      sig("vision_a", "suspect", 10),
      sig("known_fraud_template_creator", "fraud", 35),
      sig("vision_b", "fraud", 40),
    ];
    const orderBefore = ids(input);
    const snapshot = input.map((s) => ({ ...s }));

    selectTeaserSignals(input);

    expect(ids(input)).toEqual(orderBefore);
    expect(input).toEqual(snapshot);
  });

  it("returns the top two by rank when there are no vision signals at all", () => {
    const input = [
      sig("missing_exif_metadata", "clear", 95),
      sig("image_editor_software", "fraud", 30),
      sig("image_future_capture", "suspect", 25),
      sig("unusually_small_file", "fraud", 15),
    ];

    expect(ids(selectTeaserSignals(input))).toEqual([
      "image_editor_software",
      "unusually_small_file",
    ]);
  });

  it("returns the top two by rank when every signal is a vision signal", () => {
    const input = [
      sig("vision_low", "suspect", 5),
      sig("vision_high", "fraud", 30),
      sig("vision_mid", "suspect", 25),
    ];

    expect(ids(selectTeaserSignals(input))).toEqual([
      "vision_high",
      "vision_mid",
    ]);
  });

  it("returns only vision signals when more than n of them out-rank the metadata", () => {
    const input = [
      sig("vision_c", "fraud", 10),
      sig("vision_a", "fraud", 30),
      sig("vision_b", "fraud", 20),
      sig("missing_exif_metadata", "clear", 5),
    ];

    const result = selectTeaserSignals(input);

    expect(ids(result)).toEqual(["vision_a", "vision_b"]);
    expect(result.every((s) => s.id.startsWith("vision_"))).toBe(true);
  });

  it("returns everything, still ranked, when n exceeds the input length", () => {
    const input = [
      sig("missing_pdf_metadata", "clear", 5),
      sig("vision_a", "suspect", 10),
      sig("known_fraud_template_creator", "fraud", 35),
    ];

    const result = selectTeaserSignals(input, 10);

    expect(result).toHaveLength(3);
    expect(ids(result)).toEqual([
      "vision_a",
      "known_fraud_template_creator",
      "missing_pdf_metadata",
    ]);
  });

  it("keeps two distinct vision signals that share one id", () => {
    // Not hypothetical: vision.ts falls back to `vision_content_indicator`
    // whenever the model omits an id, so two findings in one response can
    // carry the same id. De-duplication must therefore be by identity, not by
    // id -- keying on id would silently drop a real second AI finding.
    const input = [
      sig("vision_content_indicator", "fraud", 30),
      sig("vision_content_indicator", "fraud", 20),
    ];

    const result = selectTeaserSignals(input);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.weight)).toEqual([30, 20]);
  });

  it("defaults n to 2", () => {
    const input = [
      sig("a_one", "fraud", 30),
      sig("a_two", "fraud", 20),
      sig("a_three", "fraud", 10),
    ];

    expect(selectTeaserSignals(input)).toHaveLength(2);
  });
});
