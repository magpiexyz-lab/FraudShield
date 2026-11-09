// A scan-pack buyer sees the single top reason their document was flagged
// (b-13), and every sentence around it tells them the truth about what they
// bought.
//
// WHY THIS FILE EXISTS, AND WHY IT IS MOSTLY ABOUT SENTENCES.
//
// /scan-result had exactly two audiences until now: Pro, who sees the full
// per-signal breakdown, and everyone else, who sees a blurred panel. Three
// separate sentences on that page therefore asserted the same thing -- that
// the evidence is Pro-only:
//
//   1. the page header, for a full PDF scan: "the signal-by-signal evidence
//      behind it is part of Pro" (not gated on tier at all, so it was already
//      being shown to subscribers who had paid for that evidence);
//   2. the sentence under "Forensic signal breakdown": "Pro shows you which";
//   3. the sentence beside the scan packs inside the locked panel:
//      "They do not reveal the signal detail above -- only Pro does."
//
// A third audience breaks all three. A pack buyer is now shown one real,
// named reason, so (1) and (2) understate what they can see, and (3) -- the
// sentence that exists because a customer lost $14 buying packs from that
// exact spot expecting an unlock -- becomes the dangerous one: it sits beside
// a buy button, next to a reason that IS now visible, and the reader has to
// come away knowing that a SECOND pack adds no second reason.
//
// vitest runs environment "node" with no jsdom in this project, so nothing
// here renders. The copy therefore lives in src/lib/billing-copy.ts, where a
// node test can read it, and the wiring is checked against the source with
// comments stripped -- a prose comment naming a claim must never be able to
// satisfy an assertion about the code that makes it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { FraudSignal } from "@/lib/types";
import type { EntitlementTier, TierRow } from "@/lib/pro-access";
import { entitlementTier, hasProAccess } from "@/lib/pro-access";
import {
  PACK_TOP_SIGNAL_COUNT,
  topNamedReasons,
  topSignals,
} from "@/lib/top-signal";
import {
  PACKS_DO_NOT_ADD_REASONS,
  PACKS_DO_NOT_UNLOCK,
  PACKS_HEADING_AFTER_LOCK,
  PACK_TOP_REASON_NOTE,
  SCORE_EVIDENCE_NOTE,
  SIGNAL_BREAKDOWN_NOTE,
  signalCountLabel,
  tierForCopy,
} from "@/lib/billing-copy";

/** The three tiers, so a Record over them can be asserted exhaustively. */
const TIERS: readonly EntitlementTier[] = ["pro", "pack", "free"];

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

// ---------------------------------------------------------------------------
// What a pack buyer may be shown
// ---------------------------------------------------------------------------

describe("topNamedReasons -- the top reason, projected to what may be printed", () => {
  it("returns exactly PACK_TOP_SIGNAL_COUNT reasons for a normal scan", () => {
    const signals = [sig("a", "clear", 5), sig("b", "fraud", 10)];
    expect(topNamedReasons(signals)).toHaveLength(PACK_TOP_SIGNAL_COUNT);
  });

  it("names the same signal topSignals ranks first", () => {
    // Positive control for the projection: the selection rule is
    // src/lib/signal-rank.ts and this function must not have its own.
    const signals = [sig("a", "clear", 90), sig("b", "suspect", 12), sig("c", "fraud", 1)];
    const [ranked] = topSignals(signals);
    expect(topNamedReasons(signals)).toEqual([
      { label: ranked.label, severity: ranked.severity },
    ]);
  });

  it("prints a label and a severity, and NOTHING else", () => {
    // THE WHOLE POINT OF THE PROJECTION. A weight next to a withheld score
    // lets the withheld points be read off the screen -- the same ban
    // tests/free-scan-panel.test.ts puts on the anonymous panel -- and a raw
    // id such as vision_arithmetic_mismatch is engine vocabulary rather than
    // a reason. The keys are asserted EXACTLY, so a detail or a weight added
    // to the projection later fails here rather than on the screen.
    const [reason] = topNamedReasons([sig("a", "fraud", 40)]);
    expect(Object.keys(reason).sort()).toEqual(["label", "severity"]);
  });

  it("drops a null entry instead of throwing", () => {
    // signals is a jsonb column: the stored array can literally contain null.
    // It ranks last, so it only surfaces when there is nothing else -- and
    // then it must not reach a renderer that reads .label off it.
    const holes = [null, undefined] as unknown as FraudSignal[];
    expect(topNamedReasons(holes)).toEqual([]);
    expect(() => topNamedReasons(holes)).not.toThrow();
  });

  it("still names a real signal when a null sits beside it", () => {
    const mixed = [null, sig("a", "suspect", 10)] as unknown as FraudSignal[];
    expect(topNamedReasons(mixed)).toEqual([
      { label: "Label for a", severity: "suspect" },
    ]);
  });
});

describe("topNamedReasons -- values the type system cannot stop", () => {
  it("shows nothing rather than promoting the runner-up when the top reason has no label", () => {
    // Rank, then slice, then drop what cannot be rendered -- in that order.
    // Filtering first would hand the reader the SECOND-ranked signal under a
    // sentence calling it the top reason, which is a false claim about the
    // evidence. Showing nothing falls back to the fully locked panel, which
    // is what they saw before and is never a lie.
    const headless = [
      { id: "a", severity: "fraud", weight: 50, detail: "d" },
      sig("b", "suspect", 10),
    ] as unknown as FraudSignal[];
    expect(topNamedReasons(headless)).toEqual([]);
  });

  it("treats a blank label as no label", () => {
    const blank = [
      { id: "a", label: "   ", severity: "fraud", weight: 50, detail: "d" },
    ] as unknown as FraudSignal[];
    expect(topNamedReasons(blank)).toEqual([]);
  });

  it("passes an unrecognised severity through for the renderer to label", () => {
    // src/app/scan-result/severity.ts is total and renders such a value as
    // "Unknown" in muted grey. Dropping the signal here would withhold a
    // reason we do have; inventing a severity would assert something false.
    const odd = [
      { id: "a", label: "Odd one", severity: "critical", weight: 9, detail: "" },
    ] as unknown as FraudSignal[];
    expect(topNamedReasons(odd)).toEqual([
      { label: "Odd one", severity: "critical" },
    ]);
  });

  it("returns an empty list for an empty, absent or malformed array", () => {
    expect(topNamedReasons([])).toEqual([]);
    expect(topNamedReasons(null)).toEqual([]);
    expect(topNamedReasons(undefined)).toEqual([]);
    expect(topNamedReasons("nope" as unknown as FraudSignal[])).toEqual([]);
  });

  it("does not mutate or reorder the array it was given", () => {
    // The full breakdown is handed the SAME array; sorting it in place would
    // reorder a surface this function has no business touching.
    const signals = [sig("a", "clear", 5), sig("b", "fraud", 10), sig("c", "suspect", 40)];
    const before = [...signals];
    topNamedReasons(signals);
    expect(signals).toEqual(before);
  });

  it("gives the same answer for the same input, every time", () => {
    const signals = [sig("a", "fraud", 10), sig("b", "fraud", 10)];
    expect(topNamedReasons(signals)).toEqual(topNamedReasons(signals));
  });
});

describe("a pack buyer cannot reach the full breakdown", () => {
  // The behavioural half of the gate. tests/entitlement-tier.test.ts owns the
  // tier table; this pins the one pairing /scan-result depends on, because the
  // unlocked breakdown is rendered from the "pro" tier and nothing else.
  const packBuyer: TierRow = {
    status: "inactive",
    stripe_subscription_id: null,
    current_period_end: null,
    scan_credits: 10,
  };
  const NOW = new Date("2026-11-09T12:00:00.000Z");

  it("is a pack, and is not Pro", () => {
    expect(entitlementTier(packBuyer, NOW)).toBe("pack");
    expect(hasProAccess(packBuyer, NOW)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------

describe("tierForCopy -- which tier's sentences a reader actually gets", () => {
  it("is the reader's own tier once a reason is on screen", () => {
    expect(tierForCopy("pack", 1)).toBe("pack");
    expect(tierForCopy("pro", 3)).toBe("pro");
    expect(tierForCopy("free", 0)).toBe("free");
  });

  it("demotes a pack buyer with nothing to show to the free sentences", () => {
    // A clean document produces no signals, and a malformed one can produce
    // none we can name. Either way the pack sentences would promise a reason
    // that is not there -- so the reader gets the fully locked wording, which
    // is true for them: they have seen nothing.
    expect(tierForCopy("pack", 0)).toBe("free");
  });

  it("never demotes Pro, who sees the whole breakdown regardless", () => {
    // Pro's rows come from SignalBreakdown, not from topNamedReasons, so a
    // zero count here says nothing about what Pro can see.
    expect(tierForCopy("pro", 0)).toBe("pro");
  });

  it("never promotes anyone", () => {
    expect(tierForCopy("free", 4)).toBe("free");
  });
});

describe("the page header stops telling a paying reader the evidence is Pro-only", () => {
  it("covers all three tiers and nothing else", () => {
    expect(Object.keys(SCORE_EVIDENCE_NOTE).sort()).toEqual([...TIERS].sort());
  });

  it("keeps the free wording exactly as it shipped", () => {
    expect(SCORE_EVIDENCE_NOTE.free).toBe(
      "Your score is below; the signal-by-signal evidence behind it is part of Pro.",
    );
  });

  it("does not tell a Pro subscriber their evidence is part of Pro", () => {
    // This sentence was never gated on tier, so every subscriber read it on
    // every full PDF scan -- directly above the breakdown they had paid for.
    expect(SCORE_EVIDENCE_NOTE.pro).not.toMatch(/part of Pro/i);
    expect(SCORE_EVIDENCE_NOTE.pro).toMatch(/below/i);
  });

  it("tells a pack buyer a reason is on the page", () => {
    expect(SCORE_EVIDENCE_NOTE.pack).not.toMatch(/part of Pro/i);
    expect(SCORE_EVIDENCE_NOTE.pack).toMatch(/top reason/i);
  });
});

describe("the sentence under the breakdown heading is tier-aware", () => {
  it("covers all three tiers and nothing else", () => {
    expect(Object.keys(SIGNAL_BREAKDOWN_NOTE).sort()).toEqual([...TIERS].sort());
  });

  it("keeps the free and the Pro wording exactly as they shipped", () => {
    expect(SIGNAL_BREAKDOWN_NOTE.free).toBe(
      "Every point in the score traces to a specific, inspectable signal. Pro shows you which.",
    );
    expect(SIGNAL_BREAKDOWN_NOTE.pro).toBe(
      "Every point in the score traces to a specific, inspectable signal.",
    );
  });

  it("does not claim a pack buyer needs Pro to see which signal it was", () => {
    // "Pro shows you which" is the claim that becomes false: they can read one
    // of them, named, a few lines further down the page.
    expect(SIGNAL_BREAKDOWN_NOTE.pack).not.toMatch(/Pro shows you which/i);
    expect(SIGNAL_BREAKDOWN_NOTE.pack).toMatch(/below/i);
  });

  it("describes the ranking it actually uses, not the score it does not", () => {
    // The ranking is severity first and weight second, so a fraud signal of
    // weight 10 outranks a suspect one of weight 40. Copy calling the result
    // "the one that moved the score most" is false on exactly that input.
    expect(SIGNAL_BREAKDOWN_NOTE.pack).not.toMatch(/moved the score/i);
  });

  it("is written for one reason, matching PACK_TOP_SIGNAL_COUNT", () => {
    // The pack wording is singular. If the count ever rises, this is where
    // that decision has to be re-read rather than silently contradicted.
    expect(PACK_TOP_SIGNAL_COUNT).toBe(1);
    expect(SIGNAL_BREAKDOWN_NOTE.pack).toMatch(/\bone\b/i);
  });
});

describe("the scan-pack sentence inside the locked panel", () => {
  it("keeps the fully-locked wording byte for byte", () => {
    // THE DECISION THIS PINS. It followed a 14 dollar refund on 6 Nov 2026: a
    // customer with scans still unused bought two packs from this panel
    // expecting an unlock. Softening it to "do not reveal the FULL signal
    // detail" leaves tests/packs-not-an-unlock.test.ts green and guts the
    // decision, so the literal is pinned here rather than a pattern.
    expect(PACKS_DO_NOT_UNLOCK).toBe(
      "Scan packs add scans to your account. They do not reveal the signal detail above — only Pro does.",
    );
    expect(PACKS_HEADING_AFTER_LOCK).toBe("Need more scans instead?");
  });

  it("has a second version for the reader who HAS been shown a reason", () => {
    // Not a rewrite of the one above: that one is read by someone who has
    // seen nothing, and it stays exactly right for them.
    expect(PACKS_DO_NOT_ADD_REASONS).not.toBe(PACKS_DO_NOT_UNLOCK);
    expect(PACKS_DO_NOT_ADD_REASONS).toMatch(/scan pack/i);
  });

  it("says a second pack buys no second reason, and points the rest at Pro", () => {
    // The load-bearing half. This sentence sits beside a buy button, a few
    // lines under a reason that IS now visible -- the exact arrangement that
    // produced the misread the first time.
    expect(PACKS_DO_NOT_ADD_REASONS).toMatch(/\bnot\b/i);
    expect(PACKS_DO_NOT_ADD_REASONS).toMatch(/reason/i);
    expect(PACKS_DO_NOT_ADD_REASONS).toMatch(/\bPro\b/);
  });

  it("does not soften the claim into not the full detail", () => {
    // The banned reword, in either voice: it invites exactly the inference
    // that another pack buys the rest of the detail.
    expect(PACKS_DO_NOT_ADD_REASONS).not.toMatch(/\bfull\b/i);
    expect(PACKS_DO_NOT_ADD_REASONS).not.toMatch(/\bcomplete\b/i);
  });

  it("names no price, so it cannot drift from what we charge", () => {
    expect(PACKS_DO_NOT_ADD_REASONS).not.toMatch(/\$|\bdollar/i);
  });
});

describe("the note beneath the revealed reason", () => {
  // Written in Task B; asserted here because this is the task that renders it.
  it("names what it is, and sends the rest to Pro rather than to packs", () => {
    expect(PACK_TOP_REASON_NOTE).toMatch(/top reason/i);
    expect(PACK_TOP_REASON_NOTE).toMatch(/\bPro\b/);
    expect(PACK_TOP_REASON_NOTE).toMatch(/scan pack/i);
  });
});

describe("signalCountLabel -- the count beside the breakdown heading", () => {
  it("still reads as a plain total for free and for Pro", () => {
    // Byte-identical to what both tiers see today: Pro's view must not change
    // in this behaviour, and the free view must not change either.
    expect(signalCountLabel("free", 5, 0)).toBe("5 signals");
    expect(signalCountLabel("pro", 5, 5)).toBe("5 signals");
  });

  it("tells a pack buyer how much of the total they are looking at", () => {
    // The honest answer beside ONE named reason. "5 signals" on its own, with
    // one of the five readable, reads as a promise of five.
    expect(signalCountLabel("pack", 5, 1)).toBe("1 of 5 shown");
  });

  it("falls back to the total when a pack buyer was shown nothing", () => {
    // "0 of 5 shown" is noise; there is no subset to describe.
    expect(signalCountLabel("pack", 5, 0)).toBe("5 signals");
  });

  it("keeps the existing plural quirk rather than changing what Pro sees", () => {
    // "1 signals" is wrong, and it is what ships today. Fixing it here would
    // change the Pro and the free rendering, which b-13 puts out of scope.
    expect(signalCountLabel("pro", 1, 1)).toBe("1 signals");
  });
});

// ---------------------------------------------------------------------------
// The wiring, which has no DOM to be tested against
// ---------------------------------------------------------------------------

const CLIENT_PATH = join(
  __dirname,
  "..",
  "src",
  "app",
  "scan-result",
  "scan-result-client.tsx",
);
const CLIENT = readFileSync(CLIENT_PATH, "utf-8");

/** Source with comments stripped, so prose cannot satisfy an assertion. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
}

/** One top-level function body, from its declaration to the next one. */
function regionOf(src: string, declaration: string): string {
  const start = src.indexOf(declaration);
  if (start < 0) return "";
  const end = src.indexOf("\nfunction ", start + declaration.length);
  return src.slice(start, end < 0 ? src.length : end);
}

const CLIENT_CODE = codeOnly(CLIENT);
const LOCKED = regionOf(CLIENT_CODE, "function LockedSignals");
/** React keys reach no reader, so they are stripped before the print bans. */
const LOCKED_PRINTED = LOCKED.replace(/key=[^\n]*/g, "");
/** The row component the panel delegates one revealed reason to. */
const REVEALED = regionOf(CLIENT_CODE, "function RevealedReason");
const REVEALED_PRINTED = REVEALED.replace(/key=[^\n]*/g, "");

const occurrences = (src: string, needle: string): number =>
  src.split(needle).length - 1;

describe("the locked panel is wired to the tier", () => {
  it("is reading the real source, and the region is delimited", () => {
    // Positive control. Every assertion below is a substring or an index check
    // over text read from disk; without this they could pass or fail for the
    // wrong reason -- a renamed file, a broken comment strip, an empty region.
    expect(CLIENT.length).toBeGreaterThan(10000);
    expect(CLIENT_CODE.length).toBeGreaterThan(CLIENT.length * 0.3);
    expect(LOCKED.length).toBeGreaterThan(1000);
    expect(LOCKED.length).toBeLessThan(CLIENT_CODE.length);
    expect(LOCKED).toContain("trackPaywallShown");
    expect(LOCKED).toContain("ScanPackOptions");
    expect(REVEALED.length).toBeGreaterThan(300);
    expect(REVEALED.length).toBeLessThan(LOCKED.length);
    expect(REVEALED).toContain("NamedReason");
  });

  it("decides the tier through entitlementTier, not an inline comparison", () => {
    expect(CLIENT_CODE).toContain("entitlementTier");
    expect(CLIENT_CODE).toContain('from "@/lib/pro-access"');
    expect(CLIENT_CODE).not.toMatch(/status\s*===\s*"active"/);
  });

  it("starts on the least-privileged tier while the row is still loading", () => {
    // FAILS CLOSED. The gap before the subscription read resolves must show
    // the locked view; the opposite default would flash a paid reason -- or
    // the whole breakdown -- at every free user on every page load.
    expect(CLIENT_CODE).toMatch(/useState<EntitlementTier>\("free"\)/);
  });

  it("names the pack tier as the only one that is handed a reason", () => {
    // Without this, widening the projection to every tier is invisible: the
    // markup is identical either way, and a free user would simply start
    // seeing the reason they have not paid for. There is no DOM here to catch
    // it, so the derivation itself is pinned.
    expect(CLIENT_CODE).toMatch(
      /const revealedReasons =\s*tier === "pack" \? topNamedReasons\(fraudSignals\) : \[\];/,
    );
    // And the copy decision is taken from that same count, so a sentence
    // cannot promise a reason the panel was never given.
    expect(CLIENT_CODE).toContain("tierForCopy(tier, revealedReasons.length)");
  });

  it("adds no second read of the subscriptions row", () => {
    // One row, one clock, one decision. A second read could disagree with the
    // first inside a single render.
    expect(occurrences(CLIENT_CODE, 'from("subscriptions")')).toBe(1);
  });

  it("unlocks the full breakdown for the pro tier and nothing else", () => {
    expect(CLIENT_CODE).toMatch(/tier === "pro"/);
    expect(occurrences(CLIENT_CODE, "<SignalBreakdown")).toBe(1);
    const breakdown = CLIENT_CODE.indexOf("<SignalBreakdown");
    expect(CLIENT_CODE.slice(Math.max(0, breakdown - 200), breakdown)).toContain(
      "isPro ?",
    );
  });

  it("keeps a pack buyer inside the locked panel, so paywall_shown still fires", () => {
    // The funnel denominator. checkout_start over paywall_shown is the
    // measurement, so moving this cohort out of the component -- or firing per
    // render instead of once per mount -- destroys the series.
    expect(LOCKED).toContain('surface: "locked_signals"');
    expect(LOCKED).toContain("firedRef");
    expect(LOCKED).toMatch(/if \(firedRef\.current\) return;/);
    expect(occurrences(CLIENT_CODE, "<LockedSignals")).toBe(1);
  });
});

describe("what the locked panel renders, per reader", () => {
  it("leaves the blurred preview exactly as the free tier sees it", () => {
    // e2e/behaviors.spec.ts asserts, as a free user, that a real signal label
    // is visible on this page. It passes only because this block renders the
    // genuine labels behind a blur.
    expect(LOCKED).toContain("signals.slice(0, 4).map");
    expect(LOCKED).toContain("blur-");
    expect(LOCKED).toContain("s.label");
  });

  it("renders the revealed reason outside the aria-hidden blurred stack", () => {
    // Inside it, the one thing a pack buyer paid for would be hidden from a
    // screen reader and impossible to select or copy.
    const revealed = LOCKED.indexOf("Top reason this document was flagged");
    const blurred = LOCKED.indexOf("select-none space-y-4 p-6 blur-");
    expect(revealed).toBeGreaterThan(-1);
    expect(blurred).toBeGreaterThan(-1);
    expect(revealed).toBeLessThan(blurred);
  });

  it("prints neither a weight nor a signal id anywhere in the panel", () => {
    // The same ban the anonymous free-scan panel carries: a weight beside a
    // withheld score lets the withheld points be read off the screen, and a
    // raw id is engine vocabulary rather than a reason.
    expect(LOCKED_PRINTED).not.toMatch(/\.weight\b/);
    expect(LOCKED_PRINTED).not.toMatch(/\.id\b/);
    expect(REVEALED_PRINTED).not.toMatch(/\.weight\b/);
    expect(REVEALED_PRINTED).not.toMatch(/\.id\b/);
    expect(REVEALED_PRINTED).not.toMatch(/\.detail\b/);
  });

  it("renders a label and a severity -- the whole of what is allowed", () => {
    // Positive control for the two bans above: the panel really does render a
    // reason, so "no weight" constrains a renderer that exists rather than
    // describing an absent one.
    expect(LOCKED).toContain("<RevealedReason");
    expect(REVEALED).toContain("severityLabel");
    expect(REVEALED).toContain("severityVar");
    expect(REVEALED).toContain("reason.label");
  });

  it("offers the packs and the upgrade exactly once each", () => {
    // A second UpgradeCta would duplicate the upgrade-pro anchor id and could
    // open two Stripe sessions from one panel.
    expect(occurrences(LOCKED, "<UpgradeCta")).toBe(1);
    expect(occurrences(CLIENT_CODE, "<ScanPackOptions")).toBe(1);
  });

  it("renders both scan-pack sentences, one per reader", () => {
    expect(LOCKED).toContain("PACKS_DO_NOT_UNLOCK");
    expect(LOCKED).toContain("PACKS_DO_NOT_ADD_REASONS");
    expect(LOCKED).toContain("PACK_TOP_REASON_NOTE");
  });

  it("takes every tier-aware sentence from the copy module", () => {
    // Inlined in JSX, none of these could be asserted at all: vitest runs
    // environment "node" here, with no jsdom.
    expect(CLIENT_CODE).toContain("SCORE_EVIDENCE_NOTE");
    expect(CLIENT_CODE).toContain("SIGNAL_BREAKDOWN_NOTE");
    expect(CLIENT_CODE).toContain("signalCountLabel");
    expect(CLIENT_CODE).toContain("tierForCopy");
    expect(CLIENT_CODE).not.toContain("part of Pro");
    expect(CLIENT_CODE).not.toContain("Pro shows you which");
  });
});

describe("the header sentence is actually separated from the filename", () => {
  it("keeps an explicit space before the tier sentence", () => {
    // JSX trims the whitespace around a newline that sits next to an
    // expression, so `</span>.` on one line and the copy expression on the
    // next render as "statement.pdf.Your score is below" with no gap. Pulling
    // the sentence out of the JSX introduced exactly that, and nothing else
    // on this page would have caught it: the words are all still correct.
    // The LINE BEFORE, not a window of characters: the paragraph already
    // contains a second {" "} after "template matching on", and a window wide
    // enough to reach this one is wide enough to be satisfied by that one.
    const lines = CLIENT_CODE.split("\n");
    const at = lines.findIndex((l) => l.includes("SCORE_EVIDENCE_NOTE[copyTier]"));
    expect(at).toBeGreaterThan(0);

    // Either spelling is correct JSX -- trailing on the line before, or
    // leading on this one -- so both are accepted. What is rejected is
    // neither, which renders the filename and the sentence as one word.
    const separated =
      lines[at - 1].trimEnd().endsWith('{" "}') ||
      lines[at].trimStart().startsWith('{" "}');
    expect(
      separated,
      "nothing explicit separates the filename from the tier sentence",
    ).toBe(true);
  });
});
