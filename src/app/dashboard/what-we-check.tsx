import { FileSearch, Clock, PenLine, Camera } from "lucide-react";

/**
 * Sits beside the drop zone on wide screens.
 *
 * The gutters either side of the upload box were dead space, and dead space
 * next to the primary action reads as an unfinished page. This fills it with
 * the thing a first-time user actually wants to know before handing over a
 * document: what happens to it.
 *
 * Every item maps to a signal the scoring engine really produces
 * (src/lib/fraud/score.ts) — no aspirational capabilities.
 *
 * lg:self-start stops the card being stretched to the row height. The left
 * column is taller now, and stretching just moves the void inside the panel —
 * a card with a blank third at the bottom reads as a loading state that never
 * finished. Ending at its own content leaves plain page background, which
 * reads as deliberate. lg:sticky then keeps it in view as the scan list
 * scrolls past, so the space earns something instead of just being empty.
 */
const CHECKS = [
  {
    icon: FileSearch,
    title: "Producer fingerprinting",
    body: "Which software wrote the file. Known fake-document generators and design tools leave their name in the metadata.",
  },
  {
    icon: Clock,
    title: "Timeline anomalies",
    body: "Creation and modification timestamps that disagree, or a document edited after it was supposedly issued.",
  },
  {
    icon: PenLine,
    title: "Editable fields",
    body: "Form fields left live in a PDF, so figures can still be typed over after the fact.",
  },
  {
    icon: Camera,
    title: "Photo forensics",
    body: "For images: capture date, editing software, and stripped EXIF — plus an AI review of the document's content.",
  },
] as const;

export function WhatWeCheck() {
  return (
    <aside
      aria-labelledby="what-we-check-heading"
      className="flex h-full flex-col rounded-[var(--radius-lg)] bg-card/60 p-5 ring-1 ring-border"
    >
      <h3
        id="what-we-check-heading"
        className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted-foreground"
      >
        What we check
      </h3>

      <ul className="mt-4 flex flex-1 flex-col justify-between gap-4">
        {CHECKS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-signal/12 text-signal ring-1 ring-signal/20"
            >
              <Icon className="size-3.5" />
            </span>
            <div className="space-y-0.5">
              <p className="text-base font-medium text-foreground">{title}</p>
              <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-4 border-t border-border pt-4 text-sm leading-relaxed text-muted-foreground">
        A score alone is not a decision. FraudShield shows the evidence behind every
        signal so you can judge it yourself.
      </p>
    </aside>
  );
}
