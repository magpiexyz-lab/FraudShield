"use client";

import type { FraudSignal } from "@/lib/types";
import { SEVERITY_LABEL, SEVERITY_VAR } from "./severity";

// The explainability IS the product (visual-brief guardrail #7): a fraud score is
// never shown without its per-signal forensic breakdown. Each signal is a row with
// a severity-colored rail, a mono signal code, a human label, and the evidence detail.
export function SignalBreakdown({ signals }: { signals: FraudSignal[] }) {
  // Order fraud → suspect → clear so the most damning evidence reads first.
  const rank: Record<FraudSignal["severity"], number> = {
    fraud: 0,
    suspect: 1,
    clear: 2,
  };
  const ordered = [...signals].sort((a, b) => rank[a.severity] - rank[b.severity]);

  return (
    <ul className="flex flex-col gap-3" aria-label="Forensic signal breakdown">
      {ordered.map((signal, index) => {
        const color = SEVERITY_VAR[signal.severity];
        return (
          <li
            key={signal.id}
            className="group relative overflow-hidden rounded-lg bg-card p-4 ring-1 ring-border transition-all duration-200 hover:ring-2 hover:-translate-y-0.5"
            style={{
              boxShadow: "0 0 0 0 transparent",
              animation: "fs-signal-in 420ms cubic-bezier(0.22,1,0.36,1) both",
              animationDelay: `${index * 70}ms`,
            }}
          >
            {/* Severity rail */}
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-1"
              style={{ backgroundColor: color }}
            />
            <div className="flex items-start justify-between gap-4 pl-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[0.7rem] uppercase tracking-wider text-muted-foreground">
                    {signal.id}
                  </span>
                  <span
                    className="rounded-pill px-2 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide"
                    style={{
                      color,
                      backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`,
                    }}
                  >
                    {SEVERITY_LABEL[signal.severity]}
                  </span>
                </div>
                <h3 className="mt-1.5 font-heading text-base font-semibold text-foreground">
                  {signal.label}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {signal.detail}
                </p>
              </div>
              {/* Per-signal weight contribution — mono metadata, reinforces the forensic read */}
              <div className="shrink-0 text-right">
                <span className="block font-mono text-[0.65rem] uppercase tracking-wider text-muted-foreground">
                  Weight
                </span>
                <span
                  className="font-mono text-lg font-medium tabular-nums"
                  style={{ color }}
                >
                  {signal.weight > 0 ? "+" : ""}
                  {signal.weight}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
