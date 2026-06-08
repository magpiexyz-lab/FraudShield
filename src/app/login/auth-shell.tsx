import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand-logo";

/**
 * AuthShell — the shared "Forensic Instrument" frame for /signup and /login.
 *
 * Split layout: a dark evidence-lab panel (left, brand + forensic texture) and
 * the form card (right). Honors the visual brief: deep cool-ink surface,
 * signal-cyan accent, Archivo headings / IBM Plex Sans body, faint forensic
 * grid + radial signal mesh. Colocated in /login (canonical owner); /signup
 * imports it.
 */
export function AuthShell({
  eyebrow,
  heading,
  subheading,
  children,
}: {
  eyebrow: string;
  heading: string;
  subheading: string;
  children: ReactNode;
}) {
  return (
    <div className="dark grid min-h-screen bg-[var(--ink)] text-foreground lg:grid-cols-[1.05fr_1fr]">
      {/* Forensic scan-beam keyframes — scoped to this shell */}
      <style>{`
        @keyframes scanbeam {
          0%   { transform: translateX(0);     opacity: 0; }
          12%  {                                opacity: 0.85; }
          50%  { transform: translateX(50vw);  opacity: 0.55; }
          88%  {                                opacity: 0.85; }
          100% { transform: translateX(100%);   opacity: 0; }
        }
      `}</style>

      {/* --- Evidence-lab panel (forensic brand surface) --- */}
      <aside className="relative hidden overflow-hidden border-r border-border px-12 py-14 lg:flex lg:flex-col lg:justify-between">
        {/* z-0: forensic grid + radial signal mesh */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, oklch(0.92 0.02 220 / 6%) 1px, transparent 1px), linear-gradient(to bottom, oklch(0.92 0.02 220 / 6%) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-24 -top-24 z-0 h-[34rem] w-[34rem] rounded-full"
          style={{
            background:
              "radial-gradient(circle, oklch(0.74 0.130 213 / 18%) 0%, transparent 65%)",
          }}
        />
        {/* slow forensic scan beam — sweeps the evidence panel */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 z-0 w-[2px] motion-safe:animate-[scanbeam_9s_ease-in-out_infinite] motion-reduce:hidden"
          style={{
            background:
              "linear-gradient(to bottom, transparent 0%, oklch(0.74 0.130 213 / 70%) 20%, oklch(0.74 0.130 213 / 70%) 80%, transparent 100%)",
            boxShadow: "0 0 14px oklch(0.74 0.130 213 / 45%)",
          }}
        />
        {/* corner registration mark — instrument fiducial */}
        <svg
          aria-hidden="true"
          viewBox="0 0 48 48"
          className="pointer-events-none absolute right-10 top-10 z-0 h-12 w-12 text-[var(--signal)]/55"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="square"
        >
          <path d="M0 9V0h9" />
          <path d="M39 0h9v9" />
          <path d="M48 39v9h-9" />
          <path d="M9 48H0v-9" />
          <circle cx="24" cy="24" r="1.4" fill="currentColor" stroke="none" />
        </svg>
        {/* spec readout — mono micro-text top-right */}
        <p className="pointer-events-none absolute right-10 top-24 z-0 font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--signal)]/55">
          FS-LAB · v1
        </p>

        {/* z-10: brand */}
        <Link
          href="/"
          className="relative z-10 inline-flex items-center gap-2.5 text-foreground"
        >
          <span
            aria-hidden="true"
            className="grid h-9 w-9 place-items-center"
          >
            <BrandMark size={32} />
          </span>
          <span className="font-[family-name:var(--font-heading)] text-xl font-bold tracking-tight">
            FraudShield
          </span>
        </Link>

        {/* z-10: forensic copy + signal markers */}
        <div className="relative z-10 max-w-md space-y-8">
          <p className="font-[family-name:var(--font-heading)] text-3xl font-semibold leading-[1.12] tracking-tight">
            Forensic fraud scores in seconds — before you approve.
          </p>
          <ul className="space-y-4 text-sm text-muted-foreground">
            {[
              ["Metadata forensics", "PDF producer, timestamps, edit history"],
              ["Cross-document checks", "Names, totals, and dates reconciled"],
              ["Known-fraud templates", "Matched against a growing signature set"],
            ].map(([title, detail], idx) => (
              <li key={title} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="relative mt-1.5 grid h-2 w-2 shrink-0 place-items-center"
                >
                  <span
                    className="absolute inset-0 animate-ping rounded-full bg-[var(--signal)]/55"
                    style={{ animationDelay: `${idx * 600}ms`, animationDuration: "2.6s" }}
                  />
                  <span className="relative h-1.5 w-1.5 rounded-full bg-[var(--signal)] shadow-[0_0_10px_var(--signal)]" />
                </span>
                <span>
                  <span className="block font-medium text-foreground">{title}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* z-10: footer segment strip */}
        <p className="relative z-10 font-mono text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Built for landlords · small lenders · gig trust teams · SMB finance
        </p>
      </aside>

      {/* --- Form column --- */}
      <section className="relative flex items-center justify-center overflow-hidden px-6 py-12 sm:px-10">
        {/* paired forensic scan-bars at the top edge — instrument readout */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--signal)]/85 to-transparent"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-[5px] h-px bg-gradient-to-r from-transparent via-[var(--signal)]/30 to-transparent"
        />
        {/* faint signal-mesh anchor behind the form, mirroring the lab panel */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-32 -bottom-24 h-[28rem] w-[28rem] rounded-full"
          style={{
            background:
              "radial-gradient(circle, oklch(0.74 0.130 213 / 9%) 0%, transparent 65%)",
          }}
        />
        <div className="w-full max-w-md">
          {/* mobile-only brand (the evidence panel is hidden on small screens) */}
          <Link
            href="/"
            className="mb-10 inline-flex items-center gap-2.5 lg:hidden"
          >
            <span
              aria-hidden="true"
              className="grid h-8 w-8 place-items-center"
            >
              <BrandMark size={28} />
            </span>
            <span className="font-[family-name:var(--font-heading)] text-lg font-bold tracking-tight">
              FraudShield
            </span>
          </Link>

          <header className="mb-8 space-y-2.5">
            <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--signal)]">
              {eyebrow}
            </p>
            <h1 className="font-[family-name:var(--font-heading)] text-3xl font-bold leading-tight tracking-tight text-foreground sm:text-4xl">
              {heading}
            </h1>
            <p className="text-[1.0625rem] leading-relaxed text-muted-foreground">
              {subheading}
            </p>
          </header>

          {children}
        </div>
      </section>
    </div>
  );
}
