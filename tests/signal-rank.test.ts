// The shared signal ranking, and why it has to be TOTAL.
//
// WHY THIS EXISTS. `byRank` and `SEVERITY_RANK` lived privately inside
// src/lib/free-scan-teaser.ts, where exactly one caller used them. b-13 gives a
// scan-pack buyer "the single top reason the document was flagged", which is
// the same ordering question asked by a second surface, so the ordering moved
// to src/lib/signal-rank.ts and both callers now share one answer.
//
// THE DEFECT THE MOVE FIXES. `SEVERITY_RANK[a.severity]` is a lookup keyed on a
// value that arrives from an untyped Supabase jsonb column. The TypeScript
// union says it is one of three strings; the database says nothing of the kind.
// For any other value the lookup yields `undefined`, the subtraction yields
// `NaN`, and a comparator returning `NaN` is treated by Array.prototype.sort as
// 0 -- so ONE unrecognised severity anywhere in the array silently degrades the
// ENTIRE sort to input order. That is precisely the failure the ranking exists
// to prevent: the free panel printing "87 / Likely forged" above whichever
// rows the engine happened to append last.
//
// An unknown or absent severity therefore sorts LAST -- after `clear`, i.e. as
// the LEAST severe thing in the list. "Worst" is ambiguous for a value we
// cannot interpret, so the direction is pinned here as a test, not left to a
// reader's guess.
//
// vitest runs environment "node" with no jsdom. Everything below is a pure
// function called directly; nothing renders.

import { describe, it, expect } from "vitest";

import type { FraudSignal } from "@/lib/types";
import { SEVERITY_RANK, byRank, severityRank } from "@/lib/signal-rank";
import {
  SEVERITY_LABEL,
  SEVERITY_VAR,
  severityLabel,
  severityVar,
} from "@/app/scan-result/severity";

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

/**
 * A signal as it can actually arrive from jsonb: any severity string, any
 * weight shape. The cast is what every read site has anyway -- Supabase hands
 * back `signals` typed only by assertion.
 */
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

/** Sorting through the comparator is how every caller uses it. */
const sorted = (signals: FraudSignal[]) => [...signals].sort(byRank);

describe("SEVERITY_RANK", () => {
  // The order the two callers depend on, pinned as data rather than inferred
  // from a sort result. Lower number = more serious = earlier in the list.
  it("ranks fraud ahead of suspect ahead of clear", () => {
    expect(SEVERITY_RANK.fraud).toBeLessThan(SEVERITY_RANK.suspect);
    expect(SEVERITY_RANK.suspect).toBeLessThan(SEVERITY_RANK.clear);
  });

  it("covers every severity in the union", () => {
    expect(Object.keys(SEVERITY_RANK).sort()).toEqual([
      "clear",
      "fraud",
      "suspect",
    ]);
  });
});

describe("severityRank", () => {
  const known: ReadonlyArray<readonly [FraudSignal["severity"], number]> = [
    ["fraud", SEVERITY_RANK.fraud],
    ["suspect", SEVERITY_RANK.suspect],
    ["clear", SEVERITY_RANK.clear],
  ];

  it.each(known)("%s keeps its declared rank", (severity, expected) => {
    expect(severityRank(severity)).toBe(expected);
  });

  // THE TOTALITY CASE. Each of these is a value the column can hold and the
  // type system cannot stop: a new severity the engine starts emitting, a
  // capitalisation drift, a NULL jsonb field, a nested object. Every one must
  // produce a NUMBER strictly greater than clear's -- sorting last -- and must
  // not produce NaN, which is what silently flattened the whole sort.
  const unknown: ReadonlyArray<readonly [string, unknown]> = [
    ["a severity the engine has not shipped yet", "critical"],
    ["a capitalised known value", "Fraud"],
    ["a padded known value", " fraud "],
    ["the empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 0],
    ["an object", { severity: "fraud" }],
    ["an array", ["fraud"]],
    // INHERITED KEYS. `SEVERITY_RANK` is an object literal, so it inherits
    // Object.prototype: a plain `SEVERITY_RANK[severity]` returns a FUNCTION
    // for these, not undefined, so a `?? fallback` never fires and the
    // subtraction yields NaN all over again. A document whose severity reads
    // "toString" is far-fetched; a jsonb column reaching a lookup that trusts
    // its own keys is not.
    ["toString", "toString"],
    ["constructor", "constructor"],
    ["valueOf", "valueOf"],
    ["hasOwnProperty", "hasOwnProperty"],
    ["__proto__", "__proto__"],
  ];

  it.each(unknown)("sorts %s after clear", (_label, severity) => {
    const rank = severityRank(severity);

    expect(Number.isNaN(rank)).toBe(false);
    expect(typeof rank).toBe("number");
    expect(rank).toBeGreaterThan(SEVERITY_RANK.clear);
  });

  it("gives every unrecognised value the same rank", () => {
    // They are indistinguishable to us, so they must not order among
    // themselves by accident -- input order decides, as for any other tie.
    expect(severityRank("critical")).toBe(severityRank(undefined));
    expect(severityRank("Fraud")).toBe(severityRank(null));
  });
});

describe("byRank", () => {
  it("puts severity ahead of weight", () => {
    // Weight is inverted against severity on purpose: severity wins outright.
    const input = [
      sig("missing_exif_metadata", "clear", 90),
      sig("suspicious_filename", "suspect", 80),
      sig("known_fraud_template_producer", "fraud", 1),
    ];

    expect(ids(sorted(input))).toEqual([
      "known_fraud_template_producer",
      "suspicious_filename",
      "missing_exif_metadata",
    ]);
  });

  it("breaks a severity tie by descending weight", () => {
    const input = [
      sig("unusually_small_file", "suspect", 5),
      sig("anomalous_modification", "suspect", 30),
      sig("future_date", "suspect", 20),
    ];

    expect(ids(sorted(input))).toEqual([
      "anomalous_modification",
      "future_date",
      "unusually_small_file",
    ]);
  });

  // THE FULL-TIE CASE. Same severity, same weight: the comparator returns 0 and
  // Array.prototype.sort is required to be stable (ES2019), so the EARLIER
  // element wins. `first_in` wins because the engine emitted it first --
  // src/lib/fraud/vision.ts returns [...base.signals, ...visionSignals], so
  // "first in the array" means the metadata detectors in the order score.ts
  // runs them. That is an arbitrary rule but a FIXED one, which is what b-13
  // asks for: "resolved the same way every time". Without stability the same
  // document could show a different top reason on two consecutive loads.
  it("keeps input order for a full tie", () => {
    const input = [
      sig("first_in", "fraud", 30),
      sig("second_in", "fraud", 30),
      sig("third_in", "fraud", 30),
    ];

    expect(ids(sorted(input))).toEqual(["first_in", "second_in", "third_in"]);
    // And the reverse input keeps ITS order -- proving the tie is decided by
    // position alone and not by anything latent in the ids or labels.
    expect(ids(sorted([...input].reverse()))).toEqual([
      "third_in",
      "second_in",
      "first_in",
    ]);
  });

  it("returns 0 for two fully tied signals", () => {
    expect(byRank(sig("a", "fraud", 30), sig("b", "fraud", 30))).toBe(0);
  });

  it("tolerates a null or undefined entry in the array", () => {
    // A jsonb array can contain nulls -- the column is `signals jsonb`, not
    // `jsonb[] not null`, so nothing in the database forbids one. Comparing a
    // null must not throw: it has no severity and no weight, so it ranks last
    // like any other value we cannot interpret.
    // TWO nulls, deliberately. One null never exercises the weight read: it
    // differs from a real signal on severity, so the comparator returns before
    // it looks at `weight`. Two nulls TIE on severity, which is the only way
    // the weight read sees one. (An `undefined` entry proves nothing either --
    // Array.prototype.sort moves those to the end without calling the
    // comparator at all -- so it is here as input noise, not as the case.)
    const real = sig("fraud_high", "fraud", 40);
    const input = [
      null as unknown as FraudSignal,
      real,
      null as unknown as FraudSignal,
      undefined as unknown as FraudSignal,
    ];

    expect(() => [...input].sort(byRank)).not.toThrow();
    expect([...input].sort(byRank)[0]).toBe(real);
  });

  it("never returns NaN, for any pairing", () => {
    // NaN is the specific poison: sort() reads it as 0, so a NaN comparison
    // does not throw and does not sort -- it quietly cancels the ordering.
    const all = [
      sig("fraud_40", "fraud", 40),
      sig("clear_0", "clear", 0),
      raw("unknown_sev", "critical", 10),
      raw("no_sev", undefined, 10),
      raw("no_weight", "fraud", undefined),
      raw("nan_weight", "fraud", Number.NaN),
      raw("null_weight", "suspect", null),
      raw("string_weight", "suspect", "40"),
      raw("proto_key_sev", "toString", 10),
      raw("proto_sev", "__proto__", 10),
    ];

    for (const a of all) {
      for (const b of all) {
        expect(Number.isNaN(byRank(a, b))).toBe(false);
      }
    }
  });

  describe("an unrecognised severity", () => {
    // THE REGRESSION, as a whole-array assertion. Before the fix this sort
    // returned its input untouched: `undefined - 0` is NaN for the very first
    // comparison, and from there sort() compares nothing meaningfully.
    it("sorts last without disturbing the recognised signals", () => {
      const input = [
        raw("mystery", "critical", 99),
        sig("clear_low", "clear", 5),
        sig("fraud_high", "fraud", 40),
        sig("suspect_mid", "suspect", 25),
      ];

      expect(ids(sorted(input))).toEqual([
        "fraud_high",
        "suspect_mid",
        "clear_low",
        "mystery",
      ]);
    });

    it("sorts last even carrying the heaviest weight in the array", () => {
      // Weight must not promote a severity we cannot interpret.
      const input = [
        raw("mystery", "critical", 1000),
        sig("clear_low", "clear", 1),
      ];

      expect(ids(sorted(input))).toEqual(["clear_low", "mystery"]);
    });

    it("sorts a missing severity last too", () => {
      const input = [raw("absent", undefined, 50), sig("clear_low", "clear", 1)];

      expect(ids(sorted(input))).toEqual(["clear_low", "absent"]);
    });

    it("orders two unrecognised severities by weight, then input order", () => {
      const input = [
        raw("mystery_light", "critical", 10),
        raw("mystery_heavy", "unheard_of", 40),
      ];

      expect(ids(sorted(input))).toEqual(["mystery_heavy", "mystery_light"]);
    });

    it("does not throw", () => {
      expect(() => sorted([raw("mystery", "critical", 10)])).not.toThrow();
    });

    // Same assertion as the table above, but as a whole-array sort: an
    // inherited key must not flatten the ordering of the real signals.
    it("sorts an inherited-key severity last, like any other unknown", () => {
      const input = [
        raw("proto_key", "toString", 99),
        sig("clear_low", "clear", 5),
        sig("fraud_high", "fraud", 40),
      ];

      expect(ids(sorted(input))).toEqual([
        "fraud_high",
        "clear_low",
        "proto_key",
      ]);
    });
  });

  describe("a missing or NaN weight", () => {
    // Treated as 0 -- "no measured contribution" -- which keeps the signal in
    // the list, ranked last among its severity, rather than cancelling the
    // sort the way NaN would.
    const broken: ReadonlyArray<readonly [string, unknown]> = [
      ["undefined", undefined],
      ["NaN", Number.NaN],
      ["null", null],
      ["a string", "40"],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["-Infinity", Number.NEGATIVE_INFINITY],
    ];

    it.each(broken)("ranks a %s weight as 0, behind a real weight", (_l, w) => {
      const input = [raw("broken", "fraud", w), sig("real", "fraud", 10)];

      expect(ids(sorted(input))).toEqual(["real", "broken"]);
    });

    it.each(broken)("ranks a %s weight level with an explicit 0", (_l, w) => {
      // Level, not merely behind: a tie, so input order decides and `broken`
      // leads here because it was emitted first.
      const input = [raw("broken", "fraud", w), sig("zero", "fraud", 0)];

      expect(byRank(input[0], input[1])).toBe(0);
      expect(ids(sorted(input))).toEqual(["broken", "zero"]);
    });

    it.each(broken)("does not throw on a %s weight", (_l, w) => {
      expect(() => sorted([raw("broken", "fraud", w)])).not.toThrow();
    });

    it("still ranks a broken weight ahead of a lower severity", () => {
      // Severity first, always: a weightless `fraud` still outranks a
      // heavy `suspect`.
      const input = [
        sig("suspect_heavy", "suspect", 90),
        raw("fraud_weightless", "fraud", undefined),
      ];

      expect(ids(sorted(input))).toEqual([
        "fraud_weightless",
        "suspect_heavy",
      ]);
    });
  });
});

// THE RENDER SIDE OF THE SAME VALUE. The rank now tolerates an unrecognised
// severity, which means such a signal can reach the screen -- and these two
// lookups were `Record<Severity, ...>` reads with no fallback. SEVERITY_LABEL
// would have rendered the chip text `undefined`, and SEVERITY_VAR would have
// produced `color-mix(in oklch, undefined 16%, transparent)`, an invalid
// declaration that drops the colour entirely. Tolerating a value in the sort
// and then printing "undefined" for it is a worse outcome than either end of
// that choice, so both lookups fall back.
describe("the severity render lookups", () => {
  const known: ReadonlyArray<FraudSignal["severity"]> = [
    "clear",
    "suspect",
    "fraud",
  ];

  it.each(known)("leaves the %s label unchanged", (severity) => {
    expect(severityLabel(severity)).toBe(SEVERITY_LABEL[severity]);
  });

  it.each(known)("leaves the %s colour unchanged", (severity) => {
    expect(severityVar(severity)).toBe(SEVERITY_VAR[severity]);
  });

  // The same table severityRank is proved total against, threaded through the
  // render lookups: one unrecognised value, one consistent outcome end to end.
  const unknown: ReadonlyArray<readonly [string, unknown]> = [
    ["a severity the engine has not shipped yet", "critical"],
    ["a capitalised known value", "Fraud"],
    ["the empty string", ""],
    ["undefined", undefined],
    ["null", null],
    ["a number", 0],
    // The render side has the same inherited-key hole: SEVERITY_LABEL
    // ["toString"] is a function, which React renders as nothing useful and
    // which interpolates into CSS as source text.
    ["toString", "toString"],
    ["__proto__", "__proto__"],
  ];

  it.each(unknown)("labels %s without printing undefined", (_l, severity) => {
    const label = severityLabel(severity as FraudSignal["severity"]);

    expect(typeof label).toBe("string");
    expect(label.length).toBeGreaterThan(0);
    expect(label.toLowerCase()).not.toContain("undefined");
  });

  it.each(unknown)("colours %s with a usable value", (_l, severity) => {
    const tone = severityVar(severity as FraudSignal["severity"]);

    expect(typeof tone).toBe("string");
    // It has to survive interpolation into color-mix(), so it must be a real
    // CSS value -- a var() reference, like every known severity returns.
    expect(tone).toMatch(/^var\(--[a-z-]+\)$/);
    expect(tone).not.toContain("undefined");
  });

  it("gives every unrecognised severity the same label and colour", () => {
    expect(severityLabel("critical" as FraudSignal["severity"])).toBe(
      severityLabel(undefined as unknown as FraudSignal["severity"]),
    );
    expect(severityVar("critical" as FraudSignal["severity"])).toBe(
      severityVar(undefined as unknown as FraudSignal["severity"]),
    );
  });

  it("does not reuse a known severity's label or colour as the fallback", () => {
    // A `critical` signal rendering as "Clear" in teal would be worse than
    // rendering as unknown: it would assert something false about the document.
    const label = severityLabel("critical" as FraudSignal["severity"]);
    const tone = severityVar("critical" as FraudSignal["severity"]);

    for (const severity of known) {
      expect(label).not.toBe(SEVERITY_LABEL[severity]);
      expect(tone).not.toBe(SEVERITY_VAR[severity]);
    }
  });

  it("does not throw on any input", () => {
    expect(() =>
      severityLabel(undefined as unknown as FraudSignal["severity"]),
    ).not.toThrow();
    expect(() =>
      severityVar(null as unknown as FraudSignal["severity"]),
    ).not.toThrow();
  });
});
