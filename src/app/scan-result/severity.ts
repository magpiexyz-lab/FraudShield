import type { FraudSignal } from "@/lib/types";

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
