import type { FraudSignal } from "@/lib/types";

/**
 * The one ordering of forensic signals, shared by every surface that shows
 * fewer signals than the scan produced.
 *
 * WHY IT IS SHARED. It used to be private to src/lib/free-scan-teaser.ts,
 * which had the only caller. b-13 gives a scan-pack buyer "the single top
 * reason the document was flagged" -- the same ordering question, asked by a
 * second surface. Two copies of a tiebreak rule is two answers to "why is THIS
 * the top reason", so there is one copy here and both callers import it.
 *
 * Pure and total: no I/O, no randomness, no `Date`, and no input it throws on.
 */

/**
 * Rank order for severity: most damning evidence first, so LOWER is worse.
 *
 * Exported for tests and for callers that need the rank without a comparator.
 * Prefer `severityRank` over indexing this directly -- see why below.
 */
export const SEVERITY_RANK: Record<FraudSignal["severity"], number> = {
  fraud: 0,
  suspect: 1,
  clear: 2,
};

/**
 * The rank given to any severity that is not one of the three declared values.
 *
 * It is strictly greater than `clear`'s, so an unrecognised severity sorts
 * LAST -- it is treated as the LEAST severe thing in the list, placed after
 * `clear`. Stated that plainly because "worst" is ambiguous for a value we
 * cannot interpret, and the direction is a decision: we will not promote an
 * uninterpretable value to the top of a paid surface, and we will not drop it
 * from the list either, because it is evidence the engine emitted.
 */
export const UNKNOWN_SEVERITY_RANK = 3;

/**
 * The rank of a severity, for ANY value.
 *
 * WHY THIS IS A FUNCTION AND NOT `SEVERITY_RANK[severity]`.
 *
 * `signals` is a jsonb column (see `ScansRow` in src/lib/types.ts). The
 * `FraudSignal` type is an assertion over whatever Postgres hands back, not a
 * guarantee about it: a severity string the engine starts emitting later, a
 * row written by an older build, a NULL field, or a hand-edited record all
 * arrive as values outside the union.
 *
 * Indexed directly, such a value yields `undefined`; `undefined - 0` is `NaN`;
 * and a comparator that returns `NaN` is read by `Array.prototype.sort` as 0.
 * So ONE unrecognised severity anywhere in the array does not misplace one row
 * -- it silently flattens the ENTIRE sort back to input order, which is the
 * exact failure this ranking exists to prevent. The engine appends the AI
 * content findings last (`applyVisionSignals` returns
 * `[...base.signals, ...visionSignals]`), so "input order" means the result
 * leads with whatever metadata detector happened to run first.
 *
 * @param severity Any value. Unrecognised or absent ones sort LAST, after
 *                 `clear`, and all share one rank so they never order among
 *                 themselves by accident.
 */
export function severityRank(severity: unknown): number {
  return isKnownSeverity(severity)
    ? SEVERITY_RANK[severity]
    : UNKNOWN_SEVERITY_RANK;
}

/**
 * Whether a value is one of the three severities we can interpret.
 *
 * WHY `hasOwnProperty` AND NOT `SEVERITY_RANK[severity] !== undefined`. The
 * maps keyed by severity are object literals, so they inherit
 * Object.prototype: `SEVERITY_RANK["toString"]` is a FUNCTION, not
 * `undefined`, and `SEVERITY_RANK["__proto__"]` is an object. A fallback
 * written as `?? UNKNOWN` therefore never fires for those keys, and the
 * function sails back into the arithmetic to produce `NaN` -- the same
 * flattened sort, reached by a different door. An own-property test is the
 * only check that answers the question actually being asked.
 *
 * Shared with the render lookups in src/app/scan-result/severity.ts so that
 * "a severity we know" has ONE definition across sorting and display.
 */
export function isKnownSeverity(
  severity: unknown,
): severity is FraudSignal["severity"] {
  return (
    typeof severity === "string" &&
    Object.prototype.hasOwnProperty.call(SEVERITY_RANK, severity)
  );
}

/**
 * A signal's weight as a number that can be compared.
 *
 * A missing, NaN or non-finite weight counts as 0 -- "no measured
 * contribution". Zero keeps the signal in the list, ranked last within its
 * severity, where `NaN` would again cancel the surrounding sort. Infinity is
 * excluded for the same reason: `Infinity - Infinity` is `NaN`.
 */
function weightOf(signal: FraudSignal | null | undefined): number {
  const weight = signal?.weight;
  return typeof weight === "number" && Number.isFinite(weight) ? weight : 0;
}

/**
 * Severity first, then weight descending. Ties keep their input order.
 *
 * Stability is load-bearing, not incidental: `Array.prototype.sort` is
 * required to be stable (ES2019), so two signals of equal severity and weight
 * stay in the order the engine emitted them. b-13 asks for a top reason
 * "resolved the same way every time", and an unstable tiebreak would let one
 * document show a different top reason on two consecutive loads.
 *
 * Total by construction: never returns `NaN` and never throws, for any pair.
 */
export function byRank(a: FraudSignal, b: FraudSignal): number {
  const bySeverity = severityRank(a?.severity) - severityRank(b?.severity);
  if (bySeverity !== 0) return bySeverity;
  return weightOf(b) - weightOf(a);
}
