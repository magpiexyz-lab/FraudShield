import type { FraudSignal } from "@/lib/types";

/**
 * Picks the handful of forensic signals the anonymous free scan is allowed to
 * show. The rest are teased behind signup, because the full per-signal
 * breakdown is the sold Pro feature.
 *
 * WHY THIS IS A FUNCTION AND NOT `signals.slice(0, 2)`.
 *
 * `applyVisionSignals` (src/lib/fraud/vision.ts) returns
 * `[...base.signals, ...visionSignals]`, so the AI content findings are always
 * LAST in the array. `SignalBreakdown` (src/app/scan-result/signal-breakdown.tsx)
 * does sort by severity -- but only after it receives its props, so slicing
 * upstream of it defeats that sort entirely.
 *
 * `slice(0, 2)` therefore shows two metadata signals and ALWAYS withholds the
 * AI finding. Metadata-only scoring detected 0 of 20 forged PDFs (see the
 * comment in src/app/api/scan/route.ts), so the free panel would print a
 * confident "87 / Likely forged" above two innocuous low-weight rows. That is
 * the worst available outcome for a surface whose entire purpose is proving a
 * real scan beats a canned animation: the number would look invented, because
 * the evidence shown would not support it.
 *
 * Pure and total -- no I/O, no randomness, no `Date`. The input array is never
 * mutated (`Array.prototype.sort` is in-place, and callers reuse the array
 * they pass in, so every sort here runs on a copy).
 */

/** Rank order for the teaser: most damning evidence first. */
const SEVERITY_RANK: Record<FraudSignal["severity"], number> = {
  fraud: 0,
  suspect: 1,
  clear: 2,
};

/**
 * Every signal emitted by the AI content pass is namespaced with this prefix,
 * unconditionally (see vision.ts). None of the metadata detector ids in
 * src/lib/fraud/score.ts start with it, so the partition below is exact.
 */
const VISION_PREFIX = "vision_";

function isVisionSignal(signal: FraudSignal): boolean {
  return signal.id.startsWith(VISION_PREFIX);
}

/** Severity first, then weight descending. Ties keep their input order. */
function byRank(a: FraudSignal, b: FraudSignal): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (bySeverity !== 0) return bySeverity;
  return b.weight - a.weight;
}

/**
 * The top `n` signals to show on the free scan, ranked, guaranteeing that an
 * AI content finding is among them whenever the scan produced one.
 *
 * @param signals All signals from the scan, in engine order.
 * @param n How many to show. `n <= 0` yields `[]`; an `n` larger than the
 *          input yields everything, still ranked.
 */
export function selectTeaserSignals(
  signals: FraudSignal[],
  n = 2,
): FraudSignal[] {
  if (n <= 0 || signals.length === 0) return [];

  // `filter` allocates, so these sorts cannot touch the caller's array.
  const vision = signals.filter(isVisionSignal).sort(byRank);
  const metadata = signals.filter((s) => !isVisionSignal(s)).sort(byRank);

  const picked: FraudSignal[] = [];

  // An AI finding always gets a slot when one exists. This can only ever
  // displace a LOWER-ranked metadata signal: vision.ts clamps vision severity
  // to fraud|suspect and never emits `clear`, so forcing one in can never
  // trade away a `fraud` row for a `clear` one.
  if (vision.length > 0) picked.push(vision[0]);

  // Fill the remaining slots from the merged ranking of what is left. The
  // forced pick is excluded by construction, so it cannot appear twice.
  // De-duplication is deliberately by identity rather than by id: vision.ts
  // falls back to `vision_content_indicator` when the model omits an id, so
  // two genuinely distinct findings can share one id, and keying on id would
  // silently drop the second.
  const remaining = [...vision.slice(picked.length), ...metadata].sort(byRank);
  for (const signal of remaining) {
    if (picked.length >= n) break;
    picked.push(signal);
  }

  return picked.slice(0, n);
}
