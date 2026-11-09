// The top reason a document was flagged (b-13).
//
// WHY A SECOND SELECTOR, AND NOT selectTeaserSignals. The teaser selector
// force-includes the first `vision_*` signal at ANY weight -- including 0 --
// ahead of a weight-40 metadata finding. That is correct for the anonymous
// free scan, whose job is proving the AI content pass ran at all, and wrong
// here: a scan-pack buyer paid for THE top reason, so a 0-weight AI note must
// not displace the finding that actually drove the score. Reusing the teaser
// selector would have shipped the anonymous surface's bias to a paying one.
//
// topSignals is therefore the plain ranking from src/lib/signal-rank.ts, with
// no force-include, and it must be TOTAL: these signals come out of an untyped
// Supabase jsonb column, so a missing weight or an unrecognised severity is a
// value to survive, not a value to assume away. It is pure -- no I/O, no
// randomness, no Date -- and never mutates its input.
//
// vitest runs environment "node" with no jsdom; nothing here renders.

import { describe, it, expect } from "vitest";

import type { FraudSignal } from "@/lib/types";
import { PACK_TOP_SIGNAL_COUNT, topSignals } from "@/lib/top-signal";
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

/** A signal as jsonb can actually deliver it: any severity, any weight. */
function raw(id: string, severity: unknown, weight: unknown): FraudSignal {
  return {
    id,
    label: `Label for ${id}`,
    severity: severity as FraudSignal["severity"],
    detail: `Detail for ${id}`,
    weight: weight as number,
  };
}

const ids = (signals: FraudSignal[]) => signals.map((s) => s.id);

describe("PACK_TOP_SIGNAL_COUNT", () => {
  // A named constant rather than a literal 1 at the call site: b-13 says "the
  // single top reason", and if that number ever changes it changes in one
  // place, with this test as the record of what it was.
  it("is one", () => {
    expect(PACK_TOP_SIGNAL_COUNT).toBe(1);
  });
});

describe("topSignals", () => {
  it("returns the most serious signal, ignoring weight", () => {
    // Weight inverted against severity: severity decides.
    const input = [
      sig("missing_exif_metadata", "clear", 90),
      sig("suspicious_filename", "suspect", 80),
      sig("known_fraud_template_producer", "fraud", 1),
    ];

    expect(ids(topSignals(input, 1))).toEqual([
      "known_fraud_template_producer",
    ]);
  });

  it("breaks a severity tie by the heaviest weight", () => {
    const input = [
      sig("unusually_small_file", "suspect", 5),
      sig("anomalous_modification", "suspect", 30),
      sig("future_date", "suspect", 20),
    ];

    expect(ids(topSignals(input, 1))).toEqual(["anomalous_modification"]);
  });

  // THE FULL-TIE CASE. Same severity, same weight -- the comparator returns 0,
  // Array.prototype.sort is stable (ES2019), so `first_in` wins BECAUSE IT WAS
  // EMITTED FIRST. The engine order is score.ts's detector order followed by
  // the vision findings (applyVisionSignals returns [...base, ...vision]), so
  // this resolves to "the earliest metadata detector that fired". Arbitrary,
  // but fixed -- b-13 requires the same document to show the same top reason
  // on every load, and an unstable tiebreak would flip it between renders.
  it("keeps input order for a full tie: the first-emitted signal wins", () => {
    const input = [
      sig("first_in", "fraud", 30),
      sig("second_in", "fraud", 30),
      sig("third_in", "fraud", 30),
    ];

    expect(ids(topSignals(input, 1))).toEqual(["first_in"]);
    // Same three signals, reversed: now `third_in` leads. Nothing but position
    // decides it, which is what makes the result reproducible per document.
    expect(ids(topSignals([...input].reverse(), 1))).toEqual(["third_in"]);
    // And the full ordering is the input ordering.
    expect(ids(topSignals(input, 3))).toEqual([
      "first_in",
      "second_in",
      "third_in",
    ]);
  });

  it("returns the top n in rank order when asked for more than one", () => {
    const input = [
      sig("missing_exif_metadata", "clear", 95),
      sig("image_editor_software", "fraud", 30),
      sig("image_future_capture", "suspect", 25),
      sig("unusually_small_file", "fraud", 15),
    ];

    expect(ids(topSignals(input, 3))).toEqual([
      "image_editor_software",
      "unusually_small_file",
      "image_future_capture",
    ]);
  });

  it("defaults n to PACK_TOP_SIGNAL_COUNT", () => {
    const input = [
      sig("a_one", "fraud", 30),
      sig("a_two", "fraud", 20),
      sig("a_three", "fraud", 10),
    ];

    expect(topSignals(input)).toHaveLength(PACK_TOP_SIGNAL_COUNT);
    expect(ids(topSignals(input))).toEqual(["a_one"]);
  });

  describe("does not inherit the teaser's vision bias", () => {
    // THE WHOLE REASON THIS FUNCTION EXISTS, stated as a difference. A
    // 0-weight AI note alongside a weight-40 metadata finding: the teaser is
    // required to show the AI note, this must show the finding that drove the
    // score. If someone later "simplifies" this to call selectTeaserSignals,
    // this test is what fails.
    const input = [
      sig("missing_pdf_metadata", "fraud", 40),
      sig("vision_content_indicator", "fraud", 0),
    ];

    it("picks the heavier metadata signal over a 0-weight vision signal", () => {
      expect(ids(topSignals(input, 1))).toEqual(["missing_pdf_metadata"]);
    });

    it("differs from selectTeaserSignals on exactly that input", () => {
      expect(ids(selectTeaserSignals(input, 1))).toEqual([
        "vision_content_indicator",
      ]);
      expect(ids(topSignals(input, 1))).not.toEqual(
        ids(selectTeaserSignals(input, 1)),
      );
    });

    it("still picks a vision signal when it genuinely out-ranks the rest", () => {
      // No bias against vision either -- it competes on severity and weight
      // like everything else.
      const visionWins = [
        sig("missing_pdf_metadata", "suspect", 40),
        sig("vision_template_mismatch", "fraud", 5),
      ];

      expect(ids(topSignals(visionWins, 1))).toEqual([
        "vision_template_mismatch",
      ]);
    });
  });

  describe("empty and degenerate inputs", () => {
    // b-13: "A result with no signals shows no top reason rather than an empty
    // one" -- the caller renders nothing when this is [], so [] is the whole
    // contract for an absent result.
    it("returns [] for no signals", () => {
      expect(topSignals([], 1)).toEqual([]);
      expect(topSignals([])).toEqual([]);
      expect(topSignals([], 10)).toEqual([]);
    });

    it("returns [] for null and undefined", () => {
      // A scan row read before its signals column is populated, or a partial
      // image analysis that returned EXIF evidence and no signals at all.
      expect(topSignals(null, 1)).toEqual([]);
      expect(topSignals(undefined, 1)).toEqual([]);
      expect(topSignals(null)).toEqual([]);
      expect(topSignals(undefined)).toEqual([]);
    });

    it("returns [] for a non-array", () => {
      // jsonb can hold an object or a string where an array was expected.
      expect(topSignals({} as unknown as FraudSignal[], 1)).toEqual([]);
      expect(topSignals("fraud" as unknown as FraudSignal[], 1)).toEqual([]);
    });

    it("returns the single signal when there is only one", () => {
      const input = [sig("only_one", "clear", 0)];

      expect(ids(topSignals(input, 1))).toEqual(["only_one"]);
    });

    it("returns a lone signal even when it is the least serious kind", () => {
      // `clear` at weight 0 is still the top reason if it is the only one --
      // picking the top of a list is not a judgement about whether the list is
      // worth showing. That judgement belongs to the caller.
      expect(ids(topSignals([sig("clear_only", "clear", 0)], 1))).toEqual([
        "clear_only",
      ]);
    });
  });

  describe("n out of range", () => {
    const input = [sig("a_one", "fraud", 30), sig("a_two", "fraud", 20)];

    it("returns [] for n = 0 and negative n", () => {
      expect(topSignals(input, 0)).toEqual([]);
      expect(topSignals(input, -1)).toEqual([]);
      expect(topSignals(input, -100)).toEqual([]);
    });

    it("returns everything, still ranked, when n exceeds the input length", () => {
      const result = topSignals(input, 10);

      expect(result).toHaveLength(2);
      expect(ids(result)).toEqual(["a_one", "a_two"]);
    });

    it("returns [] for a NaN n", () => {
      // NaN <= 0 is false, so an unguarded `slice(0, NaN)` returns [] by luck
      // rather than by rule. Pinned so it stays a rule.
      expect(topSignals(input, Number.NaN)).toEqual([]);
    });

    it("returns everything for an infinite n", () => {
      expect(ids(topSignals(input, Number.POSITIVE_INFINITY))).toEqual([
        "a_one",
        "a_two",
      ]);
    });

    it("truncates a fractional n rather than rounding up", () => {
      // 1.9 means "one whole signal". Rounding up would show a second reason
      // the caller never asked for.
      expect(ids(topSignals(input, 1.9))).toEqual(["a_one"]);
    });
  });

  describe("values the type system cannot stop", () => {
    it("sorts an unrecognised severity last and does not throw", () => {
      const input = [
        raw("mystery", "critical", 99),
        sig("clear_low", "clear", 5),
        sig("fraud_high", "fraud", 40),
      ];

      // The regression this guards: `undefined - 0` is NaN, sort() reads NaN
      // as 0, and the array came back in INPUT order -- which would have made
      // `mystery` the "top reason" a pack buyer paid to see.
      expect(ids(topSignals(input, 1))).toEqual(["fraud_high"]);
      expect(ids(topSignals(input, 3))).toEqual([
        "fraud_high",
        "clear_low",
        "mystery",
      ]);
      expect(() => topSignals(input, 1)).not.toThrow();
    });

    it("sorts a missing severity last and does not throw", () => {
      const input = [
        raw("absent", undefined, 99),
        sig("clear_low", "clear", 5),
      ];

      expect(ids(topSignals(input, 1))).toEqual(["clear_low"]);
      expect(() => topSignals(input, 1)).not.toThrow();
    });

    it("sorts an inherited-key severity last and does not throw", () => {
      // SEVERITY_RANK["toString"] is an inherited function, not undefined, so
      // a fallback keyed on `?? ` alone does not catch this one.
      const input = [
        raw("proto_key", "toString", 99),
        sig("clear_low", "clear", 5),
      ];

      expect(ids(topSignals(input, 1))).toEqual(["clear_low"]);
      expect(() => topSignals(input, 2)).not.toThrow();
    });

    it("returns an unrecognised severity when it is all there is", () => {
      // Still total: last place in a one-element list is first place.
      const input = [raw("mystery", "critical", 10)];

      expect(ids(topSignals(input, 1))).toEqual(["mystery"]);
    });

    const brokenWeights: ReadonlyArray<readonly [string, unknown]> = [
      ["undefined", undefined],
      ["NaN", Number.NaN],
      ["null", null],
      ["a string", "40"],
      ["Infinity", Number.POSITIVE_INFINITY],
    ];

    it.each(brokenWeights)("treats a %s weight as 0", (_label, weight) => {
      const input = [
        raw("broken", "fraud", weight),
        sig("real", "fraud", 10),
      ];

      expect(ids(topSignals(input, 1))).toEqual(["real"]);
      expect(() => topSignals(input, 2)).not.toThrow();
    });

    it("still prefers a weightless fraud signal over a heavy suspect one", () => {
      const input = [
        sig("suspect_heavy", "suspect", 90),
        raw("fraud_weightless", "fraud", undefined),
      ];

      expect(ids(topSignals(input, 1))).toEqual(["fraud_weightless"]);
    });

    it("survives an array of nothing but broken signals", () => {
      const input = [
        raw("one", undefined, undefined),
        raw("two", null, Number.NaN),
        raw("three", "critical", "x"),
      ];

      // All fully tied, so input order stands and the first one wins.
      expect(() => topSignals(input, 1)).not.toThrow();
      expect(ids(topSignals(input, 1))).toEqual(["one"]);
      expect(topSignals(input, 3)).toHaveLength(3);
    });
  });

  describe("purity", () => {
    it("does not mutate or reorder the caller's array", () => {
      // Array.prototype.sort is in-place. Callers pass the same `signals`
      // array to the full breakdown as well, so reordering it here would
      // silently reorder a surface this function has no business touching.
      const input = [
        sig("missing_pdf_metadata", "clear", 5),
        sig("vision_a", "suspect", 10),
        sig("known_fraud_template_creator", "fraud", 35),
      ];
      const orderBefore = ids(input);
      const snapshot = input.map((s) => ({ ...s }));

      topSignals(input, 2);

      expect(ids(input)).toEqual(orderBefore);
      expect(input).toEqual(snapshot);
    });

    it("returns the same signal objects, not copies", () => {
      // The caller renders label and detail straight off these, so identity is
      // the cheapest guarantee that nothing was rewritten on the way through.
      const input = [sig("a_one", "fraud", 30), sig("a_two", "clear", 10)];

      expect(topSignals(input, 1)[0]).toBe(input[0]);
    });

    it("gives the same answer for the same input, every time", () => {
      const input = [
        sig("first_in", "fraud", 30),
        sig("second_in", "fraud", 30),
        raw("mystery", "critical", 99),
        raw("broken", "suspect", Number.NaN),
      ];

      const once = ids(topSignals(input, 4));
      for (let i = 0; i < 5; i += 1) {
        expect(ids(topSignals(input, 4))).toEqual(once);
      }
    });
  });
});
