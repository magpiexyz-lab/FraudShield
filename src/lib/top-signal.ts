import type { FraudSignal } from "@/lib/types";
import { byRank } from "@/lib/signal-rank";

/**
 * The top reason a document was flagged (b-13).
 *
 * WHY THIS IS NOT `selectTeaserSignals`. The teaser selector force-includes
 * the first `vision_*` signal at ANY weight, including 0, ahead of a
 * weight-40 metadata finding. That is right for the anonymous free scan, whose
 * job is proving the AI content pass actually ran, and wrong here: a scan-pack
 * buyer paid for the reason that drove the score, so a 0-weight AI note must
 * not displace it. Same ordering, no force-include.
 *
 * Pure and total: no I/O, no randomness, no `Date`, no input it throws on, and
 * the caller's array is never mutated.
 */

/**
 * How many reasons a scan-pack buyer sees.
 *
 * One, deliberately: b-13 sells the full per-signal breakdown with Pro, and
 * "buying another pack reveals nothing further". A named constant rather than
 * a literal at the call site so the number changes in one line if the pricing
 * tier changes.
 */
export const PACK_TOP_SIGNAL_COUNT = 1;

/**
 * The top `n` signals, ranked by severity then weight descending, with ties
 * keeping their input order.
 *
 * @param signals All signals from the scan, in engine order. `null`,
 *                `undefined` and anything that is not an array yield `[]` --
 *                this reads a jsonb column, so an absent or malformed value is
 *                a case to survive, not one to assume away.
 * @param n How many to return. `n <= 0`, `NaN` and fractional values below 1
 *          yield `[]`; a fractional `n` truncates rather than rounds up; an
 *          `n` larger than the input yields everything, still ranked.
 */
export function topSignals(
  signals: FraudSignal[] | null | undefined,
  n: number = PACK_TOP_SIGNAL_COUNT,
): FraudSignal[] {
  // A jsonb column can hold an object or a string where an array was promised,
  // and spreading a non-iterable throws, so this is the guard that makes the
  // function total for its first argument.
  if (!Array.isArray(signals)) return [];

  // `>= 1` rather than `> 0` so that NaN and fractions below 1 are rejected by
  // the same comparison -- NaN fails every comparison, which is the one place
  // that property is useful. A separate NaN check would be unreachable: slice
  // coerces NaN to 0 anyway, so only a NEGATIVE n reaches past here and does
  // real damage (`slice(0, -1)` drops the last element instead of returning
  // nothing).
  if (!(n >= 1)) return [];

  // Spread first: `sort` is in-place, and callers pass the same array to the
  // full breakdown, so sorting theirs would reorder a surface this function
  // has no business touching.
  //
  // `slice` needs no Math.floor: it truncates a fractional end toward zero and
  // reads Infinity as "to the end", which is exactly what both mean here.
  return [...signals].sort(byRank).slice(0, n);
}

/**
 * A reason as it may appear on a surface that is withholding the rest.
 *
 * Deliberately NOT a FraudSignal. b-13 shows a scan-pack buyer the top reason
 * their document was flagged, and a FraudSignal also carries `weight` and
 * `id` -- two fields that must not reach that screen:
 *
 *   WEIGHT. The score is the sum of the weights. Printing the top signal's
 *   weight beside a score of 72 tells the reader that 32 points are hiding
 *   somewhere, which is the thing Pro is sold on. The same ban is on the
 *   anonymous free-scan panel (tests/free-scan-panel.test.ts) for exactly
 *   this reason.
 *
 *   ID. `vision_arithmetic_mismatch` is engine vocabulary. Pro's breakdown
 *   prints it beside the detail that explains it; alone it is not a reason,
 *   it is a leak of how the detector is built.
 *
 * `detail` is withheld too -- it is the "where it was found and how much it
 * moved the score" that the upgrade CTA promises. The label alone answers
 * "why was this flagged", which is what the pack buyer paid for.
 *
 * Making this a TYPE rather than a code-review promise means the projection
 * is what the renderer receives, so a weight cannot be printed by accident.
 */
export type NamedReason = {
  /** What was detected, in the engine's own words, fit to read. */
  label: string;
  /** How serious it is. Any value: the renderer's lookup is total. */
  severity: FraudSignal["severity"];
};

/**
 * The top `n` reasons, projected to what may be printed.
 *
 * RANK, THEN SLICE, THEN DROP WHAT CANNOT BE RENDERED -- in that order, and
 * the order is a decision. `signals` is a jsonb column, so an entry can be
 * `null` or an object with no usable label. Dropping those FIRST would hand
 * the reader the SECOND-ranked signal under a sentence calling it the top
 * reason, which is a false claim about the evidence. Dropping them last means
 * a broken top entry yields nothing, the caller shows the fully locked panel
 * it showed before, and no sentence on the page is a lie.
 *
 * So the returned length is at most `n`, never more, and a caller must treat
 * an empty result as "nothing to reveal" rather than as impossible.
 *
 * A severity outside the union is PASSED THROUGH, not dropped: the render
 * lookups in src/app/scan-result/severity.ts are total and print "Unknown" in
 * muted grey for it. Dropping the signal would withhold a reason we do have;
 * substituting a known severity would assert something false about the
 * document.
 *
 * Pure and total: no I/O, no randomness, no `Date`, no input it throws on, and
 * the caller's array is never mutated (topSignals copies before sorting).
 */
export function topNamedReasons(
  signals: FraudSignal[] | null | undefined,
  n: number = PACK_TOP_SIGNAL_COUNT,
): NamedReason[] {
  return topSignals(signals, n).flatMap((signal) =>
    typeof signal?.label === "string" && signal.label.trim() !== ""
      ? [{ label: signal.label, severity: signal.severity }]
      : [],
  );
}
