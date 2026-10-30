// b-12 — the guides registry has to still say what the manager wrote.
//
// The three how-to guides are SEO surfaces: they are the first thing a
// landlord or a lending desk reads about us, and every sentence in them was
// checked against what the scan actually reports before it was approved. A
// tightened sentence here is the site claiming something the product does not
// do, in public, to the exact audience we are asking to trust a score.
//
// So this file pins the copy to its source. content/guides/*.md is the
// manager's document; src/lib/guides-copy.ts is what the pages render. These
// tests fail if the two drift: the frontmatter metadata, and every FAQ
// question and answer, must match the markdown word for word.
//
// Why the copy is a module and not prose inside page.tsx: vitest runs
// environment "node" with no jsdom here, so a rendered page cannot be
// asserted. Same reason src/lib/billing-copy.ts exists. A source-text test
// against JSX would also break on Prettier re-wrapping and entity escaping,
// which means it would be deleted the first time it cried wolf.
//
// The link assertions are the other half: a guide that links to a page we
// never built, or that loses its one signup link, is a page that costs money
// to acquire traffic for and then goes nowhere.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  GUIDES,
  plainText,
  type Block,
  type Guide,
  type GuideSlug,
  type Span,
} from "@/lib/guides-copy";

const repoRoot = path.resolve(__dirname, "..");

const EXPECTED_ORDER = [
  "fake-pay-stub",
  "fake-bank-statement",
  "edited-pdf",
] as const;

/**
 * The manager's source document for a guide.
 *
 * Read from disk rather than duplicated into this file on purpose: a copy of
 * the expected text living next to the assertion proves only that two test
 * fixtures agree with each other.
 */
function readSource(slug: string): string {
  return readFileSync(
    path.join(repoRoot, "content", "guides", `${slug}.md`),
    "utf8",
  );
}

/**
 * Pull one scalar out of the YAML frontmatter.
 *
 * Deliberately a regex and not a YAML parser: adding a dependency to read four
 * strings out of three files is the kind of thing that never gets removed, and
 * the frontmatter here is flat `key: value` with optional quotes. If it ever
 * stops being that simple, this helper should fail loudly rather than quietly
 * cope, so an unmatched key throws.
 */
function frontmatter(source: string, key: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!block) throw new Error(`no frontmatter block found`);
  const line = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(block[1]);
  if (!line) throw new Error(`frontmatter key "${key}" not found`);
  const raw = line[1].trim();
  // Strip one layer of matching quotes — titles and descriptions are quoted
  // because they contain colons.
  const quoted = /^"([\s\S]*)"$|^'([\s\S]*)'$/.exec(raw);
  return quoted ? (quoted[1] ?? quoted[2]) : raw;
}

/**
 * Collapse line-wrapping only.
 *
 * The markdown is hard-wrapped by an editor and the module is wrapped by
 * Prettier, so the two disagree about where newlines fall and about nothing
 * else. Every other character — curly quotes, the middot, percent signs,
 * British spellings — is compared as written.
 */
function unwrap(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Every span in a guide body, in document order, lede through last section. */
function allSpans(guide: Guide): readonly Span[] {
  const out: Span[] = [];
  const fromBlocks = (blocks: readonly Block[]) => {
    for (const block of blocks) {
      if (block.kind === "p") out.push(...block.spans);
      else for (const item of block.items) out.push(...item);
    }
  };
  fromBlocks(guide.lede);
  for (const section of guide.sections) fromBlocks(section.blocks);
  return out;
}

/** Only the linked spans. */
function links(guide: Guide) {
  return allSpans(guide).filter(
    (span): span is { text: string; href: string } => typeof span !== "string",
  );
}

describe("GUIDES registry", () => {
  it("holds exactly the three approved guides, in reading order", () => {
    // Order is load-bearing: the guides index and the internal cross-links are
    // generated from this array, and the pay-stub guide is the head term.
    expect(GUIDES.map((g) => g.slug)).toEqual([...EXPECTED_ORDER]);
    expect(GUIDES).toHaveLength(3);
  });

  it("keeps GuideSlug a literal union rather than widening to string", () => {
    // This is the whole reason GUIDES is declared `as const satisfies
    // ReadonlyArray<Guide>` instead of `: ReadonlyArray<Guide>`. With the
    // annotation form, GuideSlug resolves to `string`, every downstream typo
    // compiles clean, and nothing in this suite would notice — the widening is
    // invisible at runtime.
    //
    // So the guard is a compile error. If the union widens, the line below
    // stops being an error, the @ts-expect-error becomes an unused directive
    // (TS2578), and `npx tsc --noEmit` fails. Asserted by the type checker,
    // not by vitest: this body is here to be compiled.
    const takesSlug = (_s: GuideSlug): void => {};
    // @ts-expect-error — "fake-paystub" is not a GuideSlug; if this stops
    // erroring, GuideSlug widened to string and the union was lost.
    takesSlug("fake-paystub");

    // And the valid ones must still be accepted.
    for (const slug of EXPECTED_ORDER) takesSlug(slug);
    expect(GUIDES.map((g) => g.slug)).toContain("fake-pay-stub");
  });
});

describe.each(GUIDES)("$slug", (guide) => {
  const source = readSource(guide.slug);
  const flat = unwrap(source);

  it("carries the metadata from its own frontmatter, unchanged", () => {
    // The title and description are the search result. They were written to a
    // length and with a promise in them; a paraphrase here is a different ad.
    expect(guide.slug).toBe(frontmatter(source, "slug"));
    expect(guide.title).toBe(frontmatter(source, "title"));
    expect(guide.description).toBe(frontmatter(source, "description"));
    expect(guide.canonical).toBe(frontmatter(source, "canonical"));
  });

  it("uses the document's own H1 and the approved byline", () => {
    const h1 = /^#[ \t]+(.+)$/m.exec(source);
    expect(h1).not.toBeNull();
    expect(guide.h1).toBe(h1![1].trim());
    expect(guide.footer).toBe("FraudShield team · October 2026");
    expect(flat).toContain(guide.footer);
  });

  it("reproduces every FAQ question and answer word for word", () => {
    expect(guide.faq.length).toBeGreaterThan(0);
    for (const { q, a } of guide.faq) {
      expect(flat, `question not found verbatim: ${q}`).toContain(unwrap(q));
      expect(flat, `answer not found verbatim: ${a}`).toContain(unwrap(a));
    }
  });

  it("links only to the signup page and to the other two guides", () => {
    // No external links and no dead internal ones. Every guide page is a paid
    // landing page; a 404 in the body is money spent to show someone an error.
    const allowed = new Set<string>([
      "/signup",
      ...GUIDES.filter((g) => g.slug !== guide.slug).map((g) => g.canonical),
    ]);
    expect(links(guide).length).toBeGreaterThan(0);
    for (const link of links(guide)) {
      expect([...allowed], `dead or external href: ${link.href}`).toContain(
        link.href,
      );
      expect(link.text.trim()).not.toBe("");
    }
  });

  it("carries exactly one signup link, labelled FraudShield", () => {
    // One CTA per guide, with one label. guide_cta_click is attributed by
    // slug, so a second signup link in the same body makes the click rate for
    // that page unreadable, and a relabelled one makes the copy test here the
    // only place the product name was pinned.
    const signup = links(guide).filter((l) => l.href === "/signup");
    expect(signup).toHaveLength(1);
    expect(signup[0].text).toBe("FraudShield");
  });
});

describe("plainText", () => {
  it("flattens a linked paragraph to prose with no markup left in it", () => {
    // The FAQ JSON-LD and the page metadata need plain strings. A stray
    // bracket in a meta description is what a hand-rolled flatten leaves
    // behind, and it ships to the search result.
    const editedPdf = GUIDES.find((g) => g.slug === "edited-pdf")!;
    const withLinks = editedPdf.lede.find(
      (block) =>
        block.kind === "p" && block.spans.some((s) => typeof s !== "string"),
    );
    expect(
      withLinks,
      "edited-pdf lede should contain a linked paragraph",
    ).toBeDefined();

    const flattened = plainText(
      (withLinks as { kind: "p"; spans: readonly Span[] }).spans,
    );
    // The link labels survive as prose...
    expect(flattened).toContain("pay stub");
    expect(flattened).toContain("bank statement");
    // ...and nothing of the markup does.
    expect(flattened).not.toContain("[");
    expect(flattened).not.toContain("]");
    expect(flattened).not.toContain("/guides/");
    // The join must not swallow the spaces either side of a link.
    expect(flattened).toContain("whether a pay stub, a bank statement");
  });

  it("returns a bare string span unchanged", () => {
    expect(plainText(["Open the file."])).toBe("Open the file.");
  });
});
