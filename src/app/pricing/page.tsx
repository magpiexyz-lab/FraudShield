import type { Metadata } from "next";
import Link from "next/link";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { buttonVariants } from "@/components/ui/button";
import { PricingPlans, ScrollReveal } from "./pricing-plans";
import { FREE_QUOTA } from "./plans";

export const metadata: Metadata = {
  title: "Pricing | FraudShield",
  description:
    "Start free with forensic document fraud detection, then upgrade to Pro for unlimited scans. Self-serve, affordable, no enterprise sales call.",
  openGraph: {
    title: "Pricing | FraudShield",
    description:
      "Start free with forensic document fraud detection, then upgrade to Pro for unlimited scans.",
    type: "website",
    url: "/pricing",
  },
};

const FAQS: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "What happens when I hit my free scan limit?",
    a: `The Free plan includes ${FREE_QUOTA} scans. Once you've used them, your next scan prompts you to upgrade to Pro — your earlier results stay available.`,
  },
  {
    q: "Do you store my uploaded documents?",
    a: "No. FraudShield never persists your raw files. We extract metadata and forensic signals in memory, return your fraud score, and discard the document.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. Pro is month-to-month with no contract. Cancel whenever you like and you keep access through the end of your billing period.",
  },
  {
    q: "What document types can FraudShield analyze?",
    a: "Pay stubs, bank statements, and invoices — as PDF or image files. Each gets a 0–100 fraud score with a per-signal forensic breakdown.",
  },
];

const TRUST_SEGMENTS = [
  "Independent landlords",
  "Small & regional lenders",
  "MCA brokers",
  "Gig-platform trust teams",
  "SMB finance & AP",
];

export default function PricingPage() {
  return (
    <div className="dark relative min-h-screen overflow-hidden bg-background text-foreground">
      {/*
        Three distinct motion primitives — no single technique repeats across
        ≥3 sections (Layer 3 anti-pattern rejection):
          .fs-reveal       — load-time translate+blur reveal (hero + plans)
          .fs-rail-segment — scroll-triggered slide-in from left (trust rail)
          .fs-faq-row      — scroll-triggered fade-up cascade per accordion row
          .fs-cta-pulse    — scroll-triggered cyan ring pulse around CTA card
        All animations are gated behind prefers-reduced-motion: no-preference.
      */}
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .fs-reveal {
            opacity: 0;
            animation: fsReveal 0.6s cubic-bezier(0.22, 1, 0.36, 1) forwards;
          }
          @keyframes fsReveal {
            from { opacity: 0; transform: translateY(16px); filter: blur(6px); }
            to { opacity: 1; transform: translateY(0); filter: blur(0); }
          }
          /* scroll-revealed: container toggled by IntersectionObserver to [data-visible="true"] */
          [data-reveal="rail"] .fs-rail-segment {
            opacity: 0;
            transform: translateX(-12px);
            transition: opacity 0.55s cubic-bezier(0.22, 1, 0.36, 1),
                        transform 0.55s cubic-bezier(0.22, 1, 0.36, 1);
          }
          [data-reveal="rail"][data-visible="true"] .fs-rail-segment {
            opacity: 1;
            transform: translateX(0);
          }
          [data-reveal="faq"] .fs-faq-row {
            opacity: 0;
            transform: translateY(8px);
            transition: opacity 0.5s ease-out, transform 0.5s ease-out;
          }
          [data-reveal="faq"][data-visible="true"] .fs-faq-row {
            opacity: 1;
            transform: translateY(0);
          }
          [data-reveal="cta"] .fs-cta-card {
            opacity: 0;
            transform: scale(0.97);
            transition: opacity 0.65s ease-out, transform 0.65s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.6s ease-out;
          }
          [data-reveal="cta"][data-visible="true"] .fs-cta-card {
            opacity: 1;
            transform: scale(1);
          }
          [data-reveal="cta"][data-visible="true"] .fs-cta-pulse {
            animation: fsCtaPulse 2.4s ease-out 0.3s 1 both;
          }
          @keyframes fsCtaPulse {
            0%   { box-shadow: 0 0 0 0 rgba(56,189,207,0.32); }
            70%  { box-shadow: 0 0 0 18px rgba(56,189,207,0); }
            100% { box-shadow: 0 0 0 0 rgba(56,189,207,0); }
          }
        }
      `}</style>

      {/* Layer 1 — atmosphere: signal-cyan radial mesh + forensic dot grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage:
            "radial-gradient(900px circle at 78% -8%, rgba(56,189,207,0.16), transparent 55%), radial-gradient(700px circle at 12% 12%, rgba(56,189,207,0.06), transparent 50%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.4]"
        style={{
          backgroundImage:
            "radial-gradient(rgba(146,170,190,0.10) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
          maskImage:
            "linear-gradient(to bottom, black, transparent 80%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black, transparent 80%)",
        }}
      />

      <div className="mx-auto w-full max-w-5xl px-6 py-20 sm:py-28">
        {/* Header */}
        <header className="fs-reveal mx-auto max-w-2xl text-center">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-signal/10 px-3 py-1 font-mono text-xs tracking-wide text-signal uppercase">
            <span className="size-1.5 rounded-full bg-signal" aria-hidden="true" />
            Simple, self-serve pricing
          </p>
          <h1 className="font-heading text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            Catch forged documents before they cost you
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Start free — no sales call, no enterprise contract. Run your first
            {" "}{FREE_QUOTA} scans on us, then upgrade to Pro when document review
            becomes part of your daily workflow.
          </p>
        </header>

        {/* Plans */}
        <section className="mt-14" aria-label="Plans">
          <PricingPlans />
        </section>

        {/*
          Trust rail — replaces the prior centered-text strip.
          Layout escape from monotony: asymmetric flex with a left mono-typed
          instrument label, a 1px signal-tinted divider, and the segments
          rendered as a horizontal track with cyan tick dividers. Scroll-
          triggered slide-in per-segment via IntersectionObserver (ScrollReveal).
        */}
        <ScrollReveal
          as="section"
          aria-label="Who uses FraudShield"
          revealKind="rail"
          className="mt-16"
        >
          <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
            <p className="font-mono text-[0.65rem] tracking-[0.22em] text-signal uppercase sm:whitespace-nowrap sm:border-r sm:border-signal/25 sm:pr-6">
              <span className="mr-2 inline-block align-middle size-1.5 rounded-full bg-signal shadow-[0_0_8px_rgba(56,189,207,0.6)]" aria-hidden="true" />
              Instrument in use by
            </p>
            <ul className="flex flex-wrap items-center gap-x-5 gap-y-3">
              {TRUST_SEGMENTS.map((segment, i) => (
                <li
                  key={segment}
                  className="fs-rail-segment flex items-center gap-5 text-sm font-medium text-foreground/85"
                  style={{ transitionDelay: `${i * 90}ms` }}
                >
                  {i > 0 && (
                    <span
                      aria-hidden="true"
                      className="hidden h-3 w-px bg-border/50 sm:inline-block"
                    />
                  )}
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="size-1 rounded-full bg-signal/70"
                    />
                    {segment}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </ScrollReveal>

        {/*
          FAQ — left-anchored asymmetric layout (escape from layout monotony),
          with a forensic mono index label, a vertical signal-cyan accent rail,
          and IntersectionObserver-triggered per-row cascade reveals.
        */}
        <ScrollReveal
          as="section"
          revealKind="faq"
          className="mt-20"
          aria-label="Frequently asked questions"
        >
          <div className="grid gap-10 lg:grid-cols-[260px_1fr]">
            <div className="lg:sticky lg:top-24 lg:self-start">
              <p className="font-mono text-[0.65rem] tracking-[0.22em] text-signal uppercase">
                §02 · Reference
              </p>
              <h2 className="mt-3 font-heading text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                Frequently asked
              </h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Quick answers on quota, data handling, billing, and supported
                document types.
              </p>
            </div>
            <div className="relative border-l border-signal/20 pl-6">
              <span
                aria-hidden="true"
                className="absolute left-[-1.5px] top-0 h-10 w-[2px] bg-gradient-to-b from-signal to-transparent"
              />
              <Accordion className="w-full">
                {FAQS.map((faq, i) => (
                  <AccordionItem
                    key={faq.q}
                    value={`faq-${i}`}
                    className="fs-faq-row border-border/50"
                    style={{ transitionDelay: `${i * 110}ms` }}
                  >
                    <AccordionTrigger className="group/trigger gap-4 py-5 text-left text-base font-medium text-foreground hover:text-signal hover:no-underline">
                      <span className="flex items-baseline gap-3">
                        <span
                          aria-hidden="true"
                          className="font-mono text-[0.65rem] tracking-widest text-signal/70 uppercase group-hover/trigger:text-signal"
                        >
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span>{faq.q}</span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="pl-10 text-sm leading-relaxed text-muted-foreground">
                      {faq.a}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </div>
          </div>
        </ScrollReveal>

        {/*
          Forward CTA — scroll-triggered scale-in + a one-shot cyan ring pulse
          drawing the eye on first view. Asymmetric two-column composition
          (left-aligned heading + right-aligned button) further breaks the
          centered-section repetition.
        */}
        <ScrollReveal
          as="section"
          revealKind="cta"
          className="mt-24"
        >
          <div className="fs-cta-card fs-cta-pulse relative overflow-hidden rounded-2xl bg-card/60 p-8 shadow-[0_0_0_1px_rgba(146,170,190,0.14),0_18px_40px_rgba(14,23,38,0.35)] backdrop-blur-sm sm:p-10">
            {/* corner forensic glyph */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-5 right-6 font-mono text-[0.65rem] tracking-[0.22em] text-signal/70 uppercase"
            >
              {"// next step"}
            </span>
            <div className="flex flex-col items-start gap-7 sm:flex-row sm:items-center sm:justify-between">
              <div className="max-w-xl">
                <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                  Not sure yet? Run a scan first.
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  See a real forensic fraud score on one of your own documents
                  before you decide. Your free scans are waiting on the dashboard.
                </p>
              </div>
              <Link
                href="/dashboard"
                className={`${buttonVariants({ variant: "outline" })} h-12 shrink-0 rounded-full border-signal/40 bg-signal/[0.06] px-7 text-base font-medium text-foreground transition-all duration-200 hover:border-signal hover:bg-signal/10 hover:shadow-[0_0_0_1px_rgba(56,189,207,0.45),0_0_24px_rgba(56,189,207,0.22)]`}
              >
                Go to your dashboard
                <span
                  aria-hidden="true"
                  className="ml-2 inline-block translate-x-0 transition-transform duration-200 group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </div>
  );
}
