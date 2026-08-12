import { Upload, ScanSearch, Gauge } from "lucide-react";

/**
 * Sits under the drop zone.
 *
 * The drop target was stretched to fill its column, which left the button
 * floating in a large empty box — a void reads as broken, not spacious. The
 * box is back to its natural size and this fills the remaining column height
 * with something worth reading.
 *
 * Three steps, because the question a first-time user has at this exact moment
 * is "what happens after I hand over a document, and how long does it take".
 */
const STEPS = [
  {
    icon: Upload,
    title: "Drop your documents",
    body: "Up to 10 at once. Nothing is stored after the scan.",
  },
  {
    icon: ScanSearch,
    title: "Forensic analysis",
    body: "Metadata, producer software, timeline, and an AI content review.",
  },
  {
    icon: Gauge,
    title: "Score in seconds",
    body: "0–100, with the evidence behind every signal.",
  },
] as const;

export function HowItWorks() {
  return (
    <ol
      aria-label="How a scan works"
      className="grid gap-3 sm:grid-cols-3"
    >
      {STEPS.map(({ icon: Icon, title, body }, index) => (
        <li
          key={title}
          className="rounded-[var(--radius-md)] bg-card/50 p-3.5 ring-1 ring-border"
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-signal/12 text-signal ring-1 ring-signal/20"
            >
              <Icon className="size-3" />
            </span>
            <span className="font-[family-name:var(--font-mono)] text-[0.7rem] tracking-wider text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {body}
          </p>
        </li>
      ))}
    </ol>
  );
}
