import type { FraudSignal } from "@/lib/types";
import type { EntitlementTier } from "@/lib/pro-access";
import { topSignals } from "@/lib/top-signal";

/**
 * The one reason a scan-history row is allowed to print (b-13).
 *
 * WHY THIS MODULE EXISTS RATHER THAN A FEW LINES INSIDE THE ROW. vitest runs
 * environment "node" with no jsdom, so src/app/dashboard/scan-history.tsx
 * cannot be rendered in a test. Written inline, every decision below -- who
 * may see a reason, which signal is the reason, and the half-dozen shapes the
 * signals column can take that must print NOTHING -- would be reachable only
 * by asserting on the spelling of JSX. Pulled out here they are a pure
 * function with a table of cases, and the component becomes a renderer with
 * one branch in it.
 *
 * Pure and total: no I/O, no clock, no randomness, no input it throws on, and
 * the array it is handed is never mutated.
 */

/**
 * What a row may print: the reason, in words, and how bad it is.
 *
 * DELIBERATELY NOT A FraudSignal. The signal also carries `weight` (an
 * internal scoring number), `id` (a detector key) and `detail` -- and
 * `detail` IS the per-signal breakdown that Pro is sold on. Returning the
 * whole signal would put all three one careless spread away from a surface
 * that must show neither, so the narrowing happens here, once, where a test
 * can check it.
 */
export type TopReason = {
  readonly label: string;
  readonly severity: FraudSignal["severity"];
};

/**
 * Whether a tier may see a reason at all.
 *
 * A POSITIVE ALLOWLIST, NOT `tier !== "free"`. entitlementTier fails closed --
 * a null row, including a read that failed and was defaulted, is "free" -- and
 * this must fail closed in the same direction. A deny-list reveals a fourth
 * tier (a trial, a team plan) the day someone names it, before anyone has
 * decided whether it has paid for anything. Being wrong by withholding shows a
 * paying customer less than they bought, which they tell us about; being wrong
 * the other way gives away what is sold, silently.
 *
 * `pack` and `pro` BOTH, and the amount shown is the same single line on this
 * surface. A history row has one line to spare, so Pro sees the same top
 * reason here and the full breakdown where there is room for it, on
 * /scan-result. b-13 is explicit that buying another pack reveals nothing
 * further; the rest comes with Pro.
 */
export function revealsTopReason(tier: EntitlementTier): boolean {
  return tier === "pack" || tier === "pro";
}

/**
 * The top reason this scan was flagged, for this tier, or null for no line.
 *
 * NULL MEANS "RENDER NOTHING", and it is the answer for far more than an
 * unpaid tier. `signals` is a jsonb column (see ScansRow in src/lib/types.ts),
 * so the FraudSignal[] annotation is a claim the caller makes about whatever
 * Postgres hands back, not a guarantee. Every one of these reaches this
 * function in production:
 *
 *   - `[]`, the COMMON case -- a clean document produces no signals at all,
 *     and a reason line with nothing in it on every clean row would be the
 *     most visible possible regression.
 *   - null, from a legacy pre-migration row.
 *   - an array containing a literal `null`. byRank tolerates it rather than
 *     letting it flatten the sort, so topSignals RETURNS it, and `.label` on
 *     null throws -- taking the whole dashboard down, not just the row.
 *   - a signal whose label is absent, blank or not a string. That is the
 *     empty line again, arriving from data instead of from an empty array:
 *     past the length check, a severity dot with nothing beside it.
 *
 * THE TIER IS CHECKED FIRST, before the signals are even looked at, so an
 * unpaid reader cannot be distinguished from a clean document by a crash, a
 * timing difference or anything else.
 *
 * AN UNPRINTABLE TOP SIGNAL WITHHOLDS THE LINE rather than falling through to
 * the next one. This row prints ONE reason, and the tier is entitled to the
 * TOP one, not to the top PRINTABLE one. Sliding down the list would present
 * the second-worst finding as though it were the worst -- and on a two-signal
 * scan that hands over half the paid breakdown because one record was
 * malformed.
 *
 * THE SEVERITY IS PASSED THROUGH UNVALIDATED, ON PURPOSE. severityLabel and
 * severityVar (src/app/scan-result/severity.ts) are already total: a value
 * outside the union renders "Unknown" in muted grey rather than the literal
 * text "undefined" and an invalid colour. Deciding a fallback here as well
 * would be a second, competing answer to a question that already has one.
 */
export function topReasonFor(
  tier: EntitlementTier,
  signals: FraudSignal[] | null | undefined,
): TopReason | null {
  if (!revealsTopReason(tier)) return null;

  // AN EXPLICIT 1, NOT PACK_TOP_SIGNAL_COUNT. A history row has one line to
  // spare, so this surface shows one reason whatever /scan-result shows -- and
  // on 2026-11-09 that number became 2. Passing the constant and then reading
  // only the first element would give the same answer by accident, and would
  // silently start printing two the day a refactor mapped over the result.
  const [top] = topSignals(signals, 1);
  // THE ONLY ENTRY THAT CAN THROW IS A NULLISH ONE. Property access on a
  // string, number or boolean sitting where an object was promised does not
  // throw -- JavaScript boxes the primitive and yields undefined -- so the
  // label check below already turns those into "no line". Only null and
  // undefined throw, and this is what stops them.
  //
  // A `typeof top !== "object"` half was written here first and removed: no
  // test could distinguish it, because no value jsonb can hold is both a
  // non-object and carries a string `label`. Proved by mutation rather than
  // argued -- deleting that half failed nothing, which is the definition of a
  // guard that guards nothing.
  if (!top) return null;

  // Trimmed, because a label of "   " is the empty line with extra steps, and
  // because the trimmed value is what gets rendered either way.
  const label = typeof top.label === "string" ? top.label.trim() : "";
  if (label === "") return null;

  return { label, severity: top.severity };
}
