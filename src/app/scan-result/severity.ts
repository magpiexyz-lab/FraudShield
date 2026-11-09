import type { FraudSignal } from "@/lib/types";
import { isKnownSeverity } from "@/lib/signal-rank";

// Severity scale shared by the score gauge and the per-signal breakdown.
// Bands map to the design tokens in globals.css:
//   --clear   (0–33)  teal-green — verified
//   --suspect (34–66) amber      — manual review
//   --fraud   (67–100) vermilion — do not approve
export type Severity = FraudSignal["severity"];

export function severityOfScore(score: number): Severity {
  if (score <= 33) return "clear";
  if (score <= 66) return "suspect";
  return "fraud";
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  clear: "Clear",
  suspect: "Suspect",
  fraud: "Fraud",
};

// CSS custom-property name per severity, used for color-mixing chips/rings.
export const SEVERITY_VAR: Record<Severity, string> = {
  clear: "var(--clear)",
  suspect: "var(--suspect)",
  fraud: "var(--fraud)",
};

// WHY THESE TWO MAPS NEED A FALLBACK.
//
// `signals` is a jsonb column (see ScansRow in src/lib/types.ts), so `severity`
// is whatever Postgres hands back, not whatever the union says. Indexed
// directly, an unrecognised value renders a chip whose text is literally
// "undefined", and a style of
// `color-mix(in oklch, undefined 16%, transparent)` -- an invalid declaration,
// so the colour is dropped and the severity rail disappears with it.
//
// src/lib/signal-rank.ts now sorts such a signal LAST rather than letting it
// flatten the entire ordering, which means it can reach the screen. Tolerating
// a value in the sort and then printing "undefined" for it on a paid surface
// would be the worse half of both choices.
//
// The fallback is deliberately NOT one of the three known severities: showing
// a `critical` signal as "Clear" in teal would assert something false about the
// document, where "Unknown" in muted grey says exactly what we know.

/** What an unrecognised severity renders as. Never one of the known three. */
export const UNKNOWN_SEVERITY_LABEL = "Unknown";
export const UNKNOWN_SEVERITY_VAR = "var(--muted-foreground)";

/**
 * The chip label for any severity, including values outside the union.
 *
 * `isKnownSeverity` is an own-property test, not a `!== undefined` test: these
 * maps are object literals, so `SEVERITY_LABEL["toString"]` is an inherited
 * FUNCTION and a `?? fallback` would never fire for it. See signal-rank.ts.
 */
export function severityLabel(severity: Severity): string {
  return isKnownSeverity(severity)
    ? SEVERITY_LABEL[severity]
    : UNKNOWN_SEVERITY_LABEL;
}

/** The CSS colour for any severity, including values outside the union. */
export function severityVar(severity: Severity): string {
  return isKnownSeverity(severity)
    ? SEVERITY_VAR[severity]
    : UNKNOWN_SEVERITY_VAR;
}
