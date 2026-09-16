import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  BILLING_TERMS,
  PRO_PRICE_LABEL,
  SUPPORT_EMAIL,
  SUPPORT_RESPONSE_SLA,
} from "@/lib/billing-copy";

// b-11 — the public billing terms.
//
// Every word of the policy comes from @/lib/billing-copy. This file renders
// it and nothing else: the same clauses are quoted on /pricing and in the
// landing footer, and a second copy of a refund sentence is a second refund
// policy. If the terms need to change, they change in the module.
//
// Layout note: the clauses are a numbered list because legal clauses get
// cited, not because numbers look tidy. Each one carries a stable id, so a
// support reply can link /terms#refunds and land the reader on the exact
// line rather than on the top of a page.

export const metadata: Metadata = {
  title: "Terms | FraudShield",
  description: `The billing terms for FraudShield Pro at ${PRO_PRICE_LABEL} — what you are charged, how to cancel it yourself, what happens to your access afterwards, and our refund policy.`,
  openGraph: {
    title: "Terms | FraudShield",
    description: `What you are charged for FraudShield Pro, how to cancel, and what cancelling does to your access.`,
    type: "website",
    url: "/terms",
  },
};

// One inline-link treatment, matching /pricing: links borrow the page's single
// accent for their underline rather than introducing a second colour, and
// carry a visible focus ring for keyboard users.
const INLINE_LINK =
  "rounded-sm text-foreground underline decoration-signal/40 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

export default function TermsPage() {
  return (
    <div className="dark relative min-h-screen overflow-hidden bg-background text-foreground">
      {/*
        One orchestrated motion moment for the whole page: a single load-time
        reveal that walks down the document. No scroll observers, no hover
        effects on the clauses — a page someone opens to find out how to stop
        being charged should sit still while they read it.
      */}
      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .fs-doc-enter {
            opacity: 0;
            animation: fsDocEnter 0.55s cubic-bezier(0.22, 1, 0.36, 1) forwards;
          }
          @keyframes fsDocEnter {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
          }
        }
      `}</style>

      {/* Atmosphere: signal-cyan radial mesh + forensic dot grid, as on /pricing */}
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
          maskImage: "linear-gradient(to bottom, black, transparent 80%)",
          WebkitMaskImage: "linear-gradient(to bottom, black, transparent 80%)",
        }}
      />

      {/* Narrower than /pricing: this is long-form reading, not a comparison grid. */}
      <div className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-28">
        <header className="fs-doc-enter">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full bg-signal/10 px-3 py-1 font-mono text-xs tracking-wide text-signal uppercase">
            <span className="size-1.5 rounded-full bg-signal" aria-hidden="true" />
            §03 · Obligations
          </p>
          <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
            What you are paying for, and how to stop
          </h1>
          <p className="mt-5 max-w-[60ch] text-lg leading-relaxed text-muted-foreground">
            FraudShield Pro is {PRO_PRICE_LABEL}. These five clauses are every
            obligation that creates, on both sides. Each clause number is a
            link, so you can send someone the exact line you are asking about.
          </p>
        </header>

        <Separator className="mt-12 bg-border/60" />

        <ol className="mt-4">
          {BILLING_TERMS.map((term, i) => {
            const numeral = String(i + 1).padStart(2, "0");
            return (
              <li
                key={term.id}
                id={term.id}
                className="fs-doc-enter scroll-mt-28 border-b border-border/40 py-9 last:border-b-0 sm:grid sm:grid-cols-[3.25rem_1fr] sm:gap-7"
                style={{ animationDelay: `${80 + i * 70}ms` }}
              >
                {/*
                  The exhibit numeral hangs in the gutter and is itself the
                  anchor: the citation handle and the deep link are the same
                  object, so there is no separate link icon to hunt for.

                  The accessible name STARTS with that visible numeral. Someone
                  driving the page by voice says "click 01" — the words they can
                  see have to be in the name they can address, or the only
                  handle on the clause is one they cannot speak (WCAG 2.5.3,
                  label-in-name). The clause heading follows it, so the name is
                  still self-describing when read out of context in a link list.
                */}
                <a
                  href={`#${term.id}`}
                  aria-label={`${numeral}, link to the clause: ${term.heading}`}
                  className="mb-1.5 inline-block rounded-sm font-mono text-3xl leading-none font-semibold tabular-nums text-signal/60 transition-colors hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-offset-4 focus-visible:ring-offset-background sm:mb-0 sm:pt-1 sm:text-right sm:text-4xl"
                >
                  {numeral}
                </a>
                <div>
                  <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                    {term.heading}
                  </h2>
                  <p className="mt-3 max-w-[62ch] text-base leading-relaxed text-muted-foreground">
                    {term.body}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        {/*
          The two things a reader of this page came here to do. Kept as the one
          raised surface on an otherwise flat document, so it reads as an
          action and not as a sixth clause.
        */}
        <section
          className="fs-doc-enter mt-14 rounded-2xl bg-card/60 p-7 shadow-[0_0_0_1px_rgba(146,170,190,0.14)] backdrop-blur-sm sm:p-9"
          style={{ animationDelay: "500ms" }}
          aria-labelledby="terms-next"
        >
          <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <h2
                id="terms-next"
                className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
              >
                Cancel, or ask us something
              </h2>
              <p className="mt-3 text-sm leading-relaxed break-words text-muted-foreground">
                Cancelling is yours to do, in your dashboard. If you would
                rather ask a person first, email{" "}
                <a href={`mailto:${SUPPORT_EMAIL}`} className={INLINE_LINK}>
                  {SUPPORT_EMAIL}
                </a>{" "}
                and you will have a reply within {SUPPORT_RESPONSE_SLA}.
              </p>
            </div>
            <Link
              href="/dashboard"
              className={`${buttonVariants({ variant: "outline" })} h-12 shrink-0 rounded-full border-signal/40 bg-signal/[0.06] px-7 text-base font-medium text-foreground transition-colors duration-200 hover:border-signal hover:bg-signal/10`}
            >
              Open your dashboard
            </Link>
          </div>
        </section>

        <p className="mt-10 text-sm leading-relaxed text-muted-foreground">
          Pricing and plan limits are on the{" "}
          <Link href="/pricing" className={INLINE_LINK}>
            pricing page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
