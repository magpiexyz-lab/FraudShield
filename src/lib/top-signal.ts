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
