import { Fragment } from "react";
import Link from "next/link";
import type { Block, Span } from "@/lib/guides-copy";
import { GUIDES } from "@/lib/guides-copy";
import { GuideCtaLink } from "./guide-cta-link";
import { GuideViewTracker } from "./guide-view-tracker";

// b-12 — the one renderer behind /guides/fake-pay-stub,
// /guides/fake-bank-statement and /guides/edited-pdf.
//
// The three routes are three static segments rather than one [slug] route on
// purpose: scripts/emit-sitemap.py walks the app directory for literal folder
// names, so a dynamic segment puts a phantom /guides/<placeholder> in the
// sitemap and leaves all three real URLs out of it. Three ten-line files are
// cheaper than a sitemap nobody trusts.
//
// This file is a server component and must stay one. Everything that needs the
// browser is isolated in the two islands it mounts.

/**
 * One guide, with its slug still a literal.
 *
 * Not `Guide` — that type widens slug to `string`, and the analytics islands
 * take `GuideSlug`. Deriving the prop type from GUIDES keeps the union intact,
 * so a page that renders the wrong entry cannot compile.
 */
export type GuideEntry = (typeof GUIDES)[number];

// The inline-link treatment, matching /terms and /pricing: links borrow the
// page's single accent for their underline rather than introducing a second
// colour, and carry a visible focus ring for keyboard users.
const INLINE_LINK =
  "rounded-sm text-foreground underline decoration-signal/40 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const BODY = "max-w-[62ch] text-base leading-relaxed text-muted-foreground";
const LEDE = "max-w-[60ch] text-lg leading-relaxed text-muted-foreground";

export function GuideArticle({ guide }: { guide: GuideEntry }) {
  // FAQPage structured data, built from the same answers the page shows. A
  // plain script tag, not next/script: beforeInteractive is only legal in the
  // root layout and silently downgrades inside a page segment, which can leave
  // the markup out of the server HTML — the only copy Googlebot reads.
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: guide.faq.map((entry) => ({
      "@type": "Question",
      name: entry.q,
      acceptedAnswer: { "@type": "Answer", text: entry.a },
    })),
  };

  // Helpers live inside the component so they can read guide.slug directly
  // rather than thread it through every call. Plain render functions, not
  // components: nothing here holds state.
  const renderSpans = (spans: readonly Span[]) =>
    spans.map((span, i) => {
      if (typeof span === "string") return <Fragment key={i}>{span}</Fragment>;
      // The single /signup span in each guide is the CTA and needs an onClick,
      // so it goes through the client island. Every other link is static.
      if (span.href === "/signup") {
        return (
          <GuideCtaLink key={i} slug={guide.slug}>
            {span.text}
          </GuideCtaLink>
        );
      }
      return (
        <Link key={i} href={span.href} className={INLINE_LINK}>
          {span.text}
        </Link>
      );
    });

  const renderBlocks = (blocks: readonly Block[]) =>
    blocks.map((block, i) =>
      block.kind === "p" ? (
        <p key={i} className={`mt-3 ${BODY}`}>
          {renderSpans(block.spans)}
        </p>
      ) : (
        // Checklists, read with a document in hand, so each item gets a mark
        // in the gutter instead of a browser disc: the same 6px signal dot the
        // rest of the site uses for "one checked signal", hung outside the
        // measure so the text edge stays flush with the paragraphs above it.
        //
        // role="list" is redundant in the accessibility tree on paper, but
        // Tailwind's base list-style: none plus display: grid items is exactly
        // the pair Safari/VoiceOver treats as "not a list", which costs a
        // screen-reader user the "list, 6 items" preamble (WCAG 1.3.1). Stating
        // the role restores it and changes nothing visual. The <li> children
        // keep their implicit listitem role once the parent role is explicit.
        <ul key={i} role="list" className="mt-4 space-y-2.5">
          {block.items.map((item, j) => (
            <li
              key={j}
              className={`grid grid-cols-[0.5rem_1fr] gap-x-4 ${BODY}`}
            >
              <span
                aria-hidden="true"
                className="mt-[0.6em] size-1.5 rounded-full bg-signal/70"
              />
              <span>{renderSpans(item)}</span>
            </li>
          ))}
        </ul>
      )
    );

  return (
    <div className="dark relative min-h-screen overflow-hidden bg-background text-foreground">
      {/*
        The payload is a compile-time constant from @/lib/guides-copy, never
        anything a user sent. The < escape is belt-and-braces for the day a
        future answer quotes a tag: an unescaped "</script" inside JSON would
        close this element early and spill the rest as markup.
      */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(faqLd).replace(/</g, "\\u003c"),
        }}
      />
      <GuideViewTracker slug={guide.slug} />

      {/* Atmosphere: signal-cyan radial mesh + forensic dot grid, as on /terms */}
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

      {/*
        No entrance animation, unlike /terms. That page is five clauses and the
        reveal lands before the reader starts; this is two thousand words of
        instructions someone is working through with a file open beside them,
        and a document that moves while it is being read is just in the way.
      */}
      <article className="mx-auto w-full max-w-3xl px-6 py-20 sm:py-28">
        <h1 className="font-heading text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-5xl">
          {guide.h1}
        </h1>

        {guide.lede.map((block, i) =>
          block.kind === "p" ? (
            <p key={i} className={`${i === 0 ? "mt-5" : "mt-4"} ${LEDE}`}>
              {renderSpans(block.spans)}
            </p>
          ) : (
            <Fragment key={i}>{renderBlocks([block])}</Fragment>
          )
        )}

        {guide.sections.map((section) => (
          <section key={section.heading} className="mt-12">
            <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
              {section.heading}
            </h2>
            {renderBlocks(section.blocks)}
          </section>
        ))}

        {/*
          The questions are the search queries this page answers, so they are
          headings and not an accordion: a reader who arrived on one of them
          should be able to find it with ctrl-F, and Google should be able to
          read the answer without running any script. The heading text is the
          manager's own, from content/guides/<slug>.md.
        */}
        <section className="mt-14">
          <h2 className="font-heading text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            Frequently asked questions
          </h2>
          <div className="mt-5 border-t border-border/40">
            {guide.faq.map((entry) => (
              <div key={entry.q} className="border-b border-border/40 py-6">
                <h3 className="font-heading text-base font-semibold text-foreground sm:text-lg">
                  {entry.q}
                </h3>
                <p className={`mt-2.5 ${BODY}`}>{entry.a}</p>
              </div>
            ))}
          </div>
        </section>

        <p className="mt-10 text-sm leading-relaxed text-muted-foreground">
          {guide.footer}
        </p>
      </article>
    </div>
  );
}
