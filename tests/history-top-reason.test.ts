// THE TOP REASON ON A SCAN-HISTORY ROW (b-13), AND WHY IT IS NOT A NEW READ.
//
// b-13 gives a scan-pack buyer "the single top reason the document was
// flagged", on the result page AND on their scan history. The history row had
// no entitlement awareness at all: scan-history.tsx selects `signals` and
// renders none of them.
//
// THE BUG THIS FILE EXISTS TO PREVENT. The obvious implementation is to add a
// from("subscriptions") read to scan-history.tsx and feed the row to
// entitlementTier. That read fails SILENTLY and in the expensive direction:
//
//   tests/entitlement-select-coverage.test.ts enforces three columns on every
//   entitlement read -- status, stripe_subscription_id, current_period_end --
//   and scan_credits is deliberately NOT among them, because two Pro-only
//   reads have no business fetching it. So a new, fully COMPLIANT read can
//   select all three required columns, pass that guard green, hand
//   entitlementTier a row whose scan_credits is undefined, and have
//   "undefined > 0" evaluate to false. Every scan-pack buyer is demoted to
//   "free" and shown nothing they paid for. Nothing throws, nothing logs, and
//   no existing guard anywhere in the suite can see it.
//
// The fix is structural rather than vigilant: there is exactly ONE compliant
// subscriptions read on this page already (src/app/dashboard/page.tsx), it
// already selects scan_credits because computeQuota needs it, and it already
// owns the single clock binding the tier decision must share. So the tier is
// derived THERE and passed down as a prop, and scan-history.tsx is forbidden
// from reading the table at all. A second read site is the defect, so the
// guard is "no second read site", not "remember four columns next time".
//
// WHY HALF OF THIS IS A SOURCE TEST. vitest runs environment "node" with no
// jsdom, so ScanHistory cannot be rendered here. The part that CAN be tested
// as behaviour is pulled into src/lib/top-reason.ts -- the tier gate, the
// ranking, and every malformed-jsonb case -- and is tested as a pure function
// below. What is left is structural: which file reads the table, which file
// receives a prop. Those have no other guard, so they are read from source,
// comment-stripped, each with a positive control proving the file loaded and
// the region was found.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { topReasonFor, revealsTopReason } from "@/lib/top-reason";
import { severityLabel } from "@/app/scan-result/severity";
import type { EntitlementTier } from "@/lib/pro-access";
import type { FraudSignal } from "@/lib/types";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

/**
 * Drop comment lines, so prose ABOUT a forbidden thing is never mistaken for
 * the thing. Every assertion below that reads source reads this.
 */
const codeOnly = (src: string) =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const HISTORY_PATH = "src/app/dashboard/scan-history.tsx";
const DASHBOARD_PATH = "src/app/dashboard/page.tsx";

const HISTORY = codeOnly(read(HISTORY_PATH));
const DASHBOARD = codeOnly(read(DASHBOARD_PATH));

const signal = (over: Partial<FraudSignal> = {}): FraudSignal => ({
  id: "sig-default",
  label: "Producer fingerprint",
  severity: "suspect",
  detail: "Created by a known pay-stub generator.",
  weight: 20,
  ...over,
});

/** A value the jsonb column can genuinely hold but the type forbids. */
const malformed = (value: unknown): FraudSignal => value as FraudSignal;

// ---------------------------------------------------------------------------
// The tier gate, as behaviour.
// ---------------------------------------------------------------------------

describe("revealsTopReason -- who may see a reason at all", () => {
  it("reveals to a scan-pack buyer and to Pro, and to nobody else", () => {
    expect(revealsTopReason("pack")).toBe(true);
    expect(revealsTopReason("pro")).toBe(true);
    expect(revealsTopReason("free")).toBe(false);
  });

  // A POSITIVE ALLOWLIST, NOT a check for "not free". entitlementTier fails
  // closed by returning "free" for a null row, and a fourth tier added later
  // (a trial, a team plan) would be revealed by a deny-list the day it is
  // named and before anyone has decided whether it is paid. An unrecognised
  // tier must buy nothing -- the same direction every other entitlement rule
  // here fails in.
  it("reveals nothing to a tier it does not recognise", () => {
    expect(revealsTopReason("trial" as EntitlementTier)).toBe(false);
    expect(revealsTopReason("" as EntitlementTier)).toBe(false);
    expect(revealsTopReason(undefined as unknown as EntitlementTier)).toBe(
      false,
    );
  });
});

describe("topReasonFor -- the tier decides, before the signals are read", () => {
  const signals = [signal({ label: "Edited in Photoshop", severity: "fraud" })];

  it("shows a scan-pack buyer the top reason", () => {
    expect(topReasonFor("pack", signals)).toEqual({
      label: "Edited in Photoshop",
      severity: "fraud",
    });
  });

  it("shows a Pro subscriber the top reason", () => {
    expect(topReasonFor("pro", signals)).toEqual({
      label: "Edited in Photoshop",
      severity: "fraud",
    });
  });

  // A free history must look EXACTLY as it does today. Not a blurred line,
  // not a teaser, not a count -- nothing.
  it("shows a free user nothing, however damning the signals", () => {
    expect(topReasonFor("free", signals)).toBeNull();
  });

  it("shows an unrecognised tier nothing", () => {
    expect(topReasonFor("trial" as EntitlementTier, signals)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What crosses the boundary: label and severity, and nothing else.
// ---------------------------------------------------------------------------

describe("topReasonFor -- only the label and the severity leave the helper", () => {
  // THE TYPE IS THE GUARD, AND THIS IS THE PROOF IT HOLDS AT RUNTIME. weight
  // is an internal scoring number and id is a detector key; both are
  // meaningless to a reader, and detail is the paid breakdown itself. A
  // helper that returned the whole signal would let any of the three reach
  // the row with one careless spread, so the helper narrows instead of
  // trusting the caller to look away.
  it("carries no weight, no id and no detail", () => {
    const reason = topReasonFor("pack", [
      signal({ id: "pdf_producer", weight: 95, detail: "The paid breakdown." }),
    ]);
    expect(Object.keys(reason!).sort()).toEqual(["label", "severity"]);
  });

  it("trims the label it does carry", () => {
    const reason = topReasonFor("pack", [
      signal({ label: "  Stripped EXIF  " }),
    ]);
    expect(reason?.label).toBe("Stripped EXIF");
  });
});

// ---------------------------------------------------------------------------
// Ranking: delegated to the shared comparator, and pinned here anyway.
// ---------------------------------------------------------------------------

describe("topReasonFor -- which signal is the top one", () => {
  it("takes the highest severity ahead of the heaviest weight", () => {
    const reason = topReasonFor("pack", [
      signal({
        label: "Heavy but merely suspect",
        severity: "suspect",
        weight: 99,
      }),
      signal({ label: "The fraud finding", severity: "fraud", weight: 1 }),
    ]);
    expect(reason?.label).toBe("The fraud finding");
  });

  it("takes the heaviest among equals", () => {
    const reason = topReasonFor("pack", [
      signal({ label: "Lighter", severity: "fraud", weight: 10 }),
      signal({ label: "Heavier", severity: "fraud", weight: 40 }),
    ]);
    expect(reason?.label).toBe("Heavier");
  });

  // b-13 asks for a reason "resolved the same way every time". Two identical
  // signals must not swap places between loads.
  it("resolves a dead tie the same way every time", () => {
    const tied = [
      signal({ label: "First emitted", severity: "fraud", weight: 30 }),
      signal({ label: "Second emitted", severity: "fraud", weight: 30 }),
    ];
    for (let i = 0; i < 20; i++) {
      expect(topReasonFor("pack", tied)?.label).toBe("First emitted");
    }
  });

  // The caller hands the SAME array to the full breakdown on /scan-result.
  // Sorting it in place would reorder a surface this helper does not own.
  it("never reorders the array it was given", () => {
    const signals = [
      signal({ label: "Clear note", severity: "clear", weight: 0 }),
      signal({ label: "Fraud note", severity: "fraud", weight: 50 }),
    ];
    const before = signals.map((s) => s.label);
    topReasonFor("pack", signals);
    expect(signals.map((s) => s.label)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Everything the jsonb column can actually hold.
// ---------------------------------------------------------------------------

describe("topReasonFor -- no row shape makes an empty line or a crash", () => {
  // THE COMMON CASE, NOT AN EDGE CASE. A clean document scores 0 and carries
  // no signals at all. Rendering a reason line with nothing in it on every
  // clean row would be the most visible possible regression.
  it("has no reason for a scan with no signals", () => {
    expect(topReasonFor("pack", [])).toBeNull();
  });

  // Legacy pre-migration rows, and a read that failed and defaulted.
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("has no reason when signals are %s", (_label, signals) => {
    expect(topReasonFor("pack", signals as FraudSignal[] | null)).toBeNull();
  });

  // jsonb promises an array and delivers whatever was written.
  it.each([
    ["an object", {}],
    ["a string", "fraud"],
    ["a number", 7],
  ])("has no reason when signals are %s", (_label, signals) => {
    expect(
      topReasonFor("pack", signals as unknown as FraudSignal[]),
    ).toBeNull();
  });

  // A LITERAL null INSIDE THE ARRAY. A one-element array holding null is
  // valid jsonb, byRank tolerates it (optional-chained severity), so
  // topSignals RETURNS that null -- and reading .label off it throws, taking
  // the whole dashboard down with it.
  it("does not crash on an array whose only entry is null", () => {
    expect(() => topReasonFor("pack", [malformed(null)])).not.toThrow();
    expect(topReasonFor("pack", [malformed(null)])).toBeNull();
  });

  // The null must not SWALLOW the reason either. An unrecognised severity
  // sorts last (signal-rank.ts), and a null entry has no severity, so a real
  // finding beside one still wins.
  it("still finds the real reason beside a null entry", () => {
    const reason = topReasonFor("pack", [
      malformed(null),
      signal({ label: "Real finding", severity: "fraud" }),
    ]);
    expect(reason?.label).toBe("Real finding");
  });

  it("does not crash on entries that are not objects", () => {
    expect(
      topReasonFor("pack", [malformed("fraud"), malformed(3), malformed(true)]),
    ).toBeNull();
  });

  // THE EMPTY LINE, ARRIVING FROM DATA RATHER THAN FROM AN EMPTY ARRAY. A
  // signal whose label is absent, blank or not a string would render a
  // severity dot with nothing beside it -- the empty reason line b-13
  // forbids, reached past the length check.
  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
    ["a number", 42],
  ])("has no reason when the top label is %s", (_label, value) => {
    expect(
      topReasonFor("pack", [malformed({ ...signal(), label: value })]),
    ).toBeNull();
  });

  // A LABELLED SIGNAL BEHIND AN UNLABELLED ONE IS STILL WITHHELD, and that is
  // deliberate rather than an oversight. PACK_TOP_SIGNAL_COUNT is 1: the pack
  // tier is entitled to the TOP reason, not to the top PRINTABLE one. Falling
  // through to the second signal would reveal a reason that is not the top
  // one while telling the reader it is -- and on a two-signal scan that is
  // half the paid breakdown, handed over by one malformed record.
  it("does not fall through when the top signal is unprintable", () => {
    const reason = topReasonFor("pack", [
      malformed({ ...signal({ severity: "fraud", weight: 90 }), label: "" }),
      signal({ label: "Second place", severity: "suspect", weight: 10 }),
    ]);
    expect(reason).toBeNull();
  });
});

describe("topReasonFor -- an odd severity reaches the renderer intact", () => {
  // IT IS NOT VALIDATED HERE, ON PURPOSE. severityLabel and severityVar
  // (src/app/scan-result/severity.ts) are already total: an unknown value
  // renders "Unknown" in muted grey rather than an invalid colour. Deciding a
  // fallback here as well would be a second, competing answer to the same
  // question -- and the one place it is answered is the place that renders.
  it("passes the severity through for the total renderer to handle", () => {
    const reason = topReasonFor("pack", [
      malformed({ ...signal(), severity: "critical" }),
    ]);
    expect(reason?.label).toBe("Producer fingerprint");
    expect(severityLabel(reason!.severity)).toBe("Unknown");
  });

  // The prototype-key case signal-rank.ts documents: SEVERITY_LABEL is an
  // object literal, so a nullish-coalescing fallback would never fire for
  // the key "toString".
  it("survives a severity that names an inherited property", () => {
    const reason = topReasonFor("pack", [
      malformed({ ...signal(), severity: "toString" }),
    ]);
    expect(severityLabel(reason!.severity)).toBe("Unknown");
  });
});

// ---------------------------------------------------------------------------
// Structural: the tier arrives as a prop, and the table is read once.
// ---------------------------------------------------------------------------

describe("the scan history takes the tier as a prop, not a billing row", () => {
  // POSITIVE CONTROL. Most assertions in this block are negative, which an
  // empty string, a moved file or a renamed component would satisfy
  // perfectly. Prove the file loaded and the component is still in it first.
  it("loaded the scan history and found its component", () => {
    expect(HISTORY.length).toBeGreaterThan(500);
    expect(HISTORY).toContain("export function ScanHistory");
  });

  // THE DEFECT, NAMED. A compliant-looking read here demotes every pack buyer
  // to free, because scan_credits is not among the columns that guard
  // enforces. There must be no read.
  it("never queries the subscriptions table", () => {
    expect(HISTORY).not.toMatch(
      /from\(\s*["'`]subscriptions["'`]\s*\)/,
    );
    expect(HISTORY).not.toContain("scan_credits");
  });

  // Not by any other name, either. A re-export or an aliased import is the
  // same read site wearing a different label.
  it("never decides entitlement for itself", () => {
    for (const predicate of [
      "entitlementTier",
      "hasProAccess",
      "computeQuota",
      "scanWindowStart",
    ]) {
      expect(
        HISTORY.includes(predicate),
        HISTORY_PATH +
          " must receive the tier as a prop, not derive it. Calling " +
          predicate +
          " here means this component is deciding entitlement from a row it " +
          "had to fetch itself.",
      ).toBe(false);
    }
  });

  it("receives the tier through its props", () => {
    expect(HISTORY).toContain("EntitlementTier");
    expect(HISTORY).toMatch(/function ScanHistory\(\{[^}]*\btier\b/s);
  });

  it("asks the shared helper for the reason", () => {
    expect(HISTORY).toContain("topReasonFor");
    expect(HISTORY).toMatch(/topReasonFor\(\s*tier\s*,/);
  });

  // TypeScript strict null checking is what proves the no-signals row renders
  // no line: reading .label off the reason does not compile until the guard
  // exists. The only ways past it are a non-null assertion and a cast, so
  // those are what is banned.
  it("does not assert its way past the no-reason case", () => {
    expect(HISTORY).not.toMatch(/\breason!/);
    expect(HISTORY).not.toMatch(/\breason as\b/);
  });

  // weight is a scoring internal. It appears nowhere else in this file, so
  // the whole-file ban is both safe and the plainest statement of the rule.
  it("prints no scoring internals", () => {
    expect(HISTORY).not.toMatch(/\bweight\b/);
    expect(HISTORY).not.toMatch(/\breason\.(id|detail)\b/);
  });

  // THE ROW ALREADY SAYS "Limited" ON A PARTIAL ANALYSIS -- an image whose AI
  // content pass never completed, shown with no score at all. Captioning an
  // EXIF finding on that row as the reason the document was "flagged" asserts
  // a verdict the row explicitly withholds, so the accessible caption is
  // chosen from the same flag that chooses the chip.
  it("does not caption a partial analysis as a verdict", () => {
    expect(HISTORY).toContain("Top reason flagged");
    expect(HISTORY).toContain("Top metadata finding");
    // And the choice between them is made by the SAME flag that chooses the
    // chip, not by anything else -- two captions selected by a different
    // condition would be the contradiction wearing a disguise.
    expect(HISTORY).toMatch(
      /fullAnalysis[\s\S]{0,120}Top reason flagged[\s\S]{0,120}Top metadata finding/,
    );
  });
});

describe("the dashboard derives the tier from the read it already makes", () => {
  const EFFECT_START = DASHBOARD.indexOf("useEffect(() => {");
  const EFFECT_END = DASHBOARD.indexOf("[quotaEpoch]");

  // POSITIVE CONTROL for the region slice below: both delimiters found, in
  // order. A -1 from either would silently slice the wrong text.
  // THE DELIMITER HAS TO START AT THE EFFECT, NOT AT THE WORD. An earlier
  // version searched for "useEffect" and matched the React IMPORT on line 3,
  // so the region ran from the imports down -- and "the tier is derived inside
  // this effect" then passed on the strength of the entitlementTier IMPORT
  // alone, with the call deleted. Found by mutation. The region must therefore
  // prove it begins AFTER the import block.
  it("found the quota effect that owns the billing read", () => {
    expect(EFFECT_START).toBeGreaterThan(-1);
    expect(EFFECT_END).toBeGreaterThan(EFFECT_START);
    const region = DASHBOARD.slice(EFFECT_START, EFFECT_END);
    expect(region).not.toContain("@/lib/pro-access");
    expect(region).toContain("maybeSingle");
  });

  const EFFECT = DASHBOARD.slice(EFFECT_START, EFFECT_END);

  it("still makes exactly one subscriptions read, with scan_credits", () => {
    expect(
      DASHBOARD.match(/from\(\s*["'`]subscriptions["'`]\s*\)/g),
    ).toHaveLength(1);
    expect(EFFECT).toContain("scan_credits");
  });

  it("derives the tier inside that effect", () => {
    expect(EFFECT).toContain("entitlementTier");
  });

  // ONE CLOCK FOR THE WHOLE DECISION. The window, the allowance and now the
  // tier are three judgements about one row, separated by an awaited count
  // query; a second clock read lets a comp expiring in that gap be Pro for
  // one and expired for another. tests/single-clock-per-quota-decision.test.ts
  // enforces the COUNT of clock reads in this effect; this pins that the tier
  // call is one of the things sharing the single binding.
  it("hands the tier the single existing clock binding", () => {
    expect(EFFECT).toMatch(/entitlementTier\([^)]*\bnow\b[^)]*\)/);
    expect(EFFECT).not.toMatch(/entitlementTier\([^)]*new Date/);
  });

  // THE DERIVED STATE, NOT JUST SOME ATTRIBUTE CALLED tier. A literal here --
  // tier="free" while debugging, and never put back -- satisfies "a tier prop
  // exists" perfectly while showing every paying customer nothing. Mutation
  // found this: the first version of this assertion passed with the value
  // hardcoded.
  it("passes the derived tier down to the scan history", () => {
    expect(DASHBOARD).toContain("<ScanHistory tier={tier} />");
  });

  // THE EXPRESSION NEXT DOOR THAT MUST NOT BE REFACTORED INTO THIS ONE.
  // purchased is a copy-only flag feeding the quota meter "Scans" versus
  // "Free scans" label, and tests/dashboard-quota-credits.test.ts pins its
  // exact spelling. It answers "did money change hands for this allowance",
  // not "what may this user see", and collapsing the two would make the
  // meter wording a function of the entitlement tier.
  it("leaves the purchased copy flag alone", () => {
    expect(DASHBOARD).toContain(
      'isPaid || purchased ? "Scans" : "Free scans"',
    );
    expect(DASHBOARD).toContain("!result.is_paid");
  });
});
