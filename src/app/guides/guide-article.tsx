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

// The lede is the answer, not an introduction: someone who arrived from a
// search result is reading it to find out whether this page is the one, and
// they decide in about four seconds. It is set a step brighter than the body
// so the first screen has somewhere to land. /terms keeps its lede at
// muted-foreground because five clauses do not need an entry point; two
// thousand words of instructions do.
//
// The bright step is plain `text-foreground` — the one the site already uses
// to lift text out of muted prose (terms:165). This was foreground/90, which
// was a third brightness level existing nowhere else in src/: oklch(0.955) at
// 90% sits a hair under the bright token and well above muted-foreground's
// oklch(0.685), so it bought nothing a reader could see and cost the palette a
// step. Brightening the lede is the right call; inventing a value for it was
// not.
const LEDE = "max-w-[60ch] text-lg leading-relaxed text-foreground";

// The chapter break. Ten H2 sections of continuous prose need a device that
// says "new section" before the reader has read a word of it — on a phone the
// whole document is eight screens of unbroken grey without one. A hairline is
// the same separator the FAQ list and the /terms clauses already use, so this
// adds structure without adding a new visual idea to the site.
const CHAPTER = "mt-10 border-t border-border/40 pt-10";

// The one raised surface on an otherwise flat document, inherited from the
// closing action on /terms (which wraps its two buttons and nothing else).
//
// It wraps the CTA PARAGRAPH, not the section the paragraph happens to sit in.
// Keying it to the section made the card mean two different things across the
// set: on fake-pay-stub and fake-bank-statement the /signup span is the whole
// of a 65-word "Run a scan" section, so the card was an action panel; on
// edited-pdf the same span sits in the middle of "What a scan adds, and what it
// does not" — 162 words across a caveat, the CTA, and a closing disclaimer —
// so the card raised an essay with the action buried inside it, and took about
// a fifth of a five-section page doing it. Scoped to the block, the card says
// exactly one thing on all three pages: this is the action. The caveats around
// it on edited-pdf go back to being body prose, which is what they are.
const ACTION_CARD =
  "rounded-2xl bg-card/60 p-6 shadow-[0_0_0_1px_rgba(146,170,190,0.14)] backdrop-blur-sm sm:p-8";

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

  // Vertical rhythm is set by what a block sits NEXT to, not by one margin for
  // every block. Several sections here run lead-in line, list, lead-in line,
  // list ("What to look for:" / "What it does not prove:"), and with one
  // uniform gap a lead-in floats exactly halfway between the list it closes
  // and the list it opens — the reader cannot tell which one it belongs to.
  // Binding each lead-in tightly to its own list and opening up the gap after
  // a list makes those pairs read as pairs.
  const renderBlocks = (blocks: readonly Block[]) =>
    blocks.map((block, i) => {
      const afterList = i > 0 && blocks[i - 1].kind === "ul";

      // The CTA paragraph: the single /signup span in the guide. Found by the
      // href and not by the heading above it, because the headings are the
      // manager's and all three guides are free to name their sections
      // differently — but matched on the block now, so the surface lands on
      // the action itself wherever in a section the action happens to fall.
      const isCta =
        block.kind === "p" &&
        block.spans.some(
          (span) => typeof span !== "string" && span.href === "/signup"
        );

      if (block.kind === "p" && isCta) {
        return (
          // mt-6 regardless of what precedes it, where a plain paragraph takes
          // mt-3: a surface that lifts off the page needs clearance on all four
          // sides to read as lifted, and 12px against a 24px inset makes it
          // look stuck to the paragraph or heading above. The paragraph inside
          // carries no margin of its own — the card's padding is the spacing.
          <div key={i} className={`mt-6 ${ACTION_CARD}`}>
            <p className={BODY}>{renderSpans(block.spans)}</p>
          </div>
        );
      }

      return block.kind === "p" ? (
        <p key={i} className={`${afterList ? "mt-6" : "mt-3"} ${BODY}`}>
          {renderSpans(block.spans)}
        </p>
      ) : (
        // Checklists, read with a document in hand, so each item gets a mark
        // in the gutter instead of a browser disc: the same 6px signal dot the
        // rest of the site uses for "one checked signal", set in a narrow
        // column so every item's text hangs on one edge however many lines it
        // runs to. The column is inside the measure, not outside it: at 390px
        // there are only 24px of page padding to hang into, and a mark sitting
        // on the screen edge reads as a rendering fault rather than a bullet.
        //
        // role="list" is redundant in the accessibility tree on paper, but
        // Tailwind's base list-style: none plus display: grid items is exactly
        // the pair Safari/VoiceOver treats as "not a list", which costs a
        // screen-reader user the "list, 6 items" preamble (WCAG 1.3.1). Stating
        // the role restores it and changes nothing visual. The <li> children
        // keep their implicit listitem role once the parent role is explicit.
        //
        // space-y-4 and not the tighter step: leading-relaxed already puts
        // 10px of air between the lines inside an item, and several items here
        // run to five or six lines. An inter-item gap the size of the
        // inter-line gap makes eight bullets read as one paragraph with dots
        // in it. The gap has to beat the leading for the items to separate.
        <ul
          key={i}
          role="list"
          className={`${i === 0 ? "mt-4" : "mt-3"} space-y-4`}
        >
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
      );
    });

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
        No entrance animation, unlike /terms (.fs-doc-enter) and /pricing
        (.fs-reveal). Deliberate, and not just the "a document being read
        should not move" argument — that one does apply to /terms too, which is
        also long-form and animates anyway.
        The reason these three differ: .fs-doc-enter starts its element at
        `opacity: 0` and holds it there for 0.55s plus its stagger delay. An
        element at opacity 0 is not an LCP candidate, so the reveal moves
        Largest Contentful Paint later by its own duration. These are the only
        three pages in the set entered cold from a search result, where LCP is
        both a ranking input and the four seconds the reader spends deciding
        whether this is the page they wanted. /terms is reached from a
        dashboard by someone already signed in and is measured by nobody.
        Paying real LCP for a decorative reveal is a trade worth making there
        and not here. The page is not motionless by accident: it keeps the
        signal-cyan mesh and dot grid, and the CTA island reacts to input.
      */}
      {/*
        Narrower than /terms' max-w-3xl. That page spends its width on a
        3.25rem numeral gutter beside each clause; this one is a single column
        of running text, and at 3xl the column was 125px wider than the 62ch
        measure inside it, so headings, rules and body all ended on different
        edges. At 2xl the container and the measure are within 30px of each
        other and the document reads as one column.

        pt is shorter than pb on a phone: 80px of empty space above the H1 is
        a tenth of a 390x844 screen spent before the headline, on a page whose
        job is to answer the question in the first four seconds.
      */}
      <article className="mx-auto w-full max-w-2xl px-6 pt-14 pb-20 sm:py-28">
        {/*
          Straight to the H1, with no eyebrow kicker, where /terms and /pricing
          both open on a mono uppercase signal pill ("§03 · Obligations",
          "§02 · Reference"). Deliberate.
          That pill is a locator, not a badge: it says "you are at position N of
          the reference set". Three guides have no position — they are siblings,
          reached from each other and from search, in no order. A pill reading
          "GUIDE · Documents" would copy the pill's form while dropping the only
          thing its form carries, which leaves the site with one component
          meaning two different things. That is the same defect as the action
          card wrapping an essay, and it is not worth re-introducing one level
          up to close a gap.
          The gap is also narrower than it looks: the doc family is already
          legible above the fold here. NavBar renders on /guides/* (it is
          suppressed only on /, /signup, /login, /v/ and /auth/), and the
          mesh-and-dot-grid atmosphere, the 4xl/5xl font-heading H1 and the
          inline-link treatment are the same ones /terms uses. What is missing
          is the ordinal, and the guides have no ordinal. The 36px a pill would
          take also comes straight out of the shortened phone pt below, which
          was shortened for the four seconds this page gets.
        */}
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

        {/*
          Every section is a chapter, with no exceptions. The action does not
          get a section of its own treatment — ACTION_CARD lands on the CTA
          paragraph inside renderBlocks, so the one raised surface marks the
          action and not whichever heading the action was filed under. The link
          inside it stays a link in a sentence: the surface does the signalling
          so the prose does not have to become a button.
        */}
        {guide.sections.map((section) => (
          <section key={section.heading} className={CHAPTER}>
            {/*
              One size at every width, where /terms steps down to text-xl on a
              phone. Its five clauses each carry a 3xl numeral beside them and
              never need the heading to do the finding; here the heading is the
              only handle on a section, and at 20px against 18px lede and 16px
              body it was barely a step at all on the width where most of this
              traffic reads. 24/16 is a step a skimmer can see.
            */}
            <h2 className="font-heading text-2xl font-semibold tracking-tight text-balance text-foreground">
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
        <section className={CHAPTER}>
          <h2 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            Frequently asked questions
          </h2>
          {/*
            No second rule above the first question: the chapter rule and the
            heading have already opened this section, and two hairlines sixty
            pixels apart read as a mistake. Each question keeps the rule below
            it, so the questions still look like the rows they are.
          */}
          <div className="mt-4">
            {guide.faq.map((entry) => (
              <div
                key={entry.q}
                className="border-b border-border/40 py-6 last:border-b-0 last:pb-0"
              >
                {/*
                  A step above the body rather than level with it. These are
                  the search queries the page answers, and on a phone a
                  question set at body size in a different weight is not a
                  heading a skimming reader can find.
                */}
                <h3 className="font-heading text-lg font-semibold text-balance text-foreground">
                  {entry.q}
                </h3>
                <p className={`mt-2.5 ${BODY}`}>{entry.a}</p>
              </div>
            ))}
          </div>
        </section>

        {/* The byline closes the document, so it gets a rule to close against. */}
        <p className="mt-10 border-t border-border/40 pt-6 text-sm leading-relaxed text-muted-foreground">
          {guide.footer}
        </p>
      </article>
    </div>
  );
}
