import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { GUIDES, plainText, type Guide } from "@/lib/guides-copy";

// b-12 — the three guide pages.
//
// vitest runs environment "node" here and the project has no jsdom, so these
// pages cannot be rendered. The source is asserted as text instead, which is
// the right level for what is actually at risk on an SEO surface: not "does it
// paint", but "does /guides/edited-pdf carry the pay-stub guide's canonical",
// "did someone retype a FAQ answer into JSX", and "is the JSON-LD in the
// server HTML where Googlebot reads it".
//
// Every source is run through stripComments first. Without that, a comment in
// a page that happens to mention trackGuideCtaClick satisfies the assertion
// that the CTA is wired up — the prose passes the test and the page ships
// dead.

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => {
  const abs = path.join(repoRoot, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
};

// Drop comment lines and comment blocks. Deliberately line-oriented rather
// than a tokenizer: it removes JSX comment blocks, block comments, and lines
// that start with // or *, and leaves string literals alone, so an asserted
// class name or an href is never truncated at an inner slash-slash.
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith("//") || t.startsWith("*"));
    })
    .join("\n");
}

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

const ARTICLE_REL = "src/app/guides/guide-article.tsx";
const VIEW_REL = "src/app/guides/guide-view-tracker.tsx";
const CTA_REL = "src/app/guides/guide-cta-link.tsx";

const articleSrc = stripComments(read(ARTICLE_REL));
const viewSrc = stripComments(read(VIEW_REL));
const ctaSrc = stripComments(read(CTA_REL));
const layoutSrc = stripComments(read("src/app/layout.tsx"));

// Everything that ends up in a guide's rendered tree: the route segment, the
// shared article renderer, and the two client islands it mounts.
const sharedTree = [articleSrc, viewSrc, ctaSrc].join("\n");

const pageRel = (slug: string) => `src/app/guides/${slug}/page.tsx`;
const pageSrc = (slug: string) => stripComments(read(pageRel(slug)));
const treeFor = (slug: string) => [pageSrc(slug), sharedTree].join("\n");

describe("b-12: the guide route segments exist", () => {
  it("has a page for all three registry slugs", () => {
    expect(GUIDES).toHaveLength(3);
    for (const guide of GUIDES) {
      expect(
        existsSync(path.join(repoRoot, pageRel(guide.slug))),
        `missing ${pageRel(guide.slug)}`
      ).toBe(true);
    }
  });

  it("has no [slug] dynamic route, which would break the sitemap", () => {
    expect(existsSync(path.join(repoRoot, "src/app/guides/[slug]"))).toBe(false);
  });

  it("has a shared article renderer and its two client islands", () => {
    expect(existsSync(path.join(repoRoot, ARTICLE_REL))).toBe(true);
    expect(existsSync(path.join(repoRoot, VIEW_REL))).toBe(true);
    expect(existsSync(path.join(repoRoot, CTA_REL))).toBe(true);
  });

  it("keeps the renderer a server component and the islands client components", () => {
    expect(articleSrc).not.toMatch(/["']use client["']/);
    expect(viewSrc).toMatch(/^\s*["']use client["']/);
    expect(ctaSrc).toMatch(/^\s*["']use client["']/);
  });

  // The checklists are the only prose lists on the site, and renderBlocks
  // gives each <li> display: grid on top of Tailwind's base list-style: none.
  // Safari/VoiceOver drops list and listitem semantics for exactly that
  // combination, so a screen-reader user loses the "list, 6 items" preamble
  // and any way to jump the list. An explicit role on the container restores
  // it and changes no pixel. The items need no role of their own: once the
  // parent role is explicit their implicit listitem role is honoured.
  it("keeps list semantics on the checklist <ul> for screen readers", () => {
    const uls = articleSrc.match(/<ul\s[^>]*>/g) ?? [];
    expect(uls.length).toBeGreaterThan(0);
    for (const ul of uls) {
      expect(ul, `<ul> with no explicit role: ${ul}`).toMatch(
        /role=["']list["']/
      );
    }
  });
});

describe.each(GUIDES as readonly Guide[])("b-12: /guides/$slug", (guide) => {
  const others = GUIDES.filter((g) => g.slug !== guide.slug);

  it("stays a server component so metadata is honoured", () => {
    expect(pageSrc(guide.slug)).not.toMatch(/["']use client["']/);
  });

  it("exports typed Metadata built from the registry entry", () => {
    const src = pageSrc(guide.slug);
    expect(src).toMatch(/export\s+const\s+metadata\s*:\s*Metadata/);
    expect(src).toMatch(
      /import\s*\{[\s\S]*?\bGUIDES\b[\s\S]*?\}\s*from\s*["']@\/lib\/guides-copy["']/
    );
    // title and description are read, never retyped: once for the document
    // title and once for the Open Graph title.
    expect(count(src, "guide.title")).toBeGreaterThanOrEqual(2);
    expect(count(src, "guide.description")).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain(guide.title);
    expect(src).not.toContain(guide.description);
    expect(src).toMatch(/openGraph:\s*\{/);
    expect(src).toMatch(/type:\s*["']website["']/);
  });

  it("sets its canonical from the registry and hardcodes no absolute URL", () => {
    const src = pageSrc(guide.slug);
    expect(src).toMatch(/alternates:\s*\{[\s\S]*?canonical:\s*guide\.canonical/);
    expect(src).not.toMatch(/https:\/\//);
    expect(src).not.toContain(guide.canonical);
  });

  it("looks up its own slug and no other guide's", () => {
    const src = pageSrc(guide.slug);
    expect(src).toContain(`"${guide.slug}"`);
    for (const other of others) {
      expect(src, `leaks ${other.slug}`).not.toContain(`"${other.slug}"`);
    }
  });

  it("hands the whole entry to the shared renderer", () => {
    const src = pageSrc(guide.slug);
    expect(src).toMatch(/<GuideArticle\s+guide=\{guide\}/);
    expect(src).toMatch(
      /import\s+\{?\s*GuideArticle\s*\}?\s+from\s+["']\.\.\/guide-article["']/
    );
  });

  it("carries exactly one /signup link, through the CTA island", () => {
    // Enforced upstream by the registry, restated here because the whole
    // attribution of guide_cta_click rests on it.
    const spanRuns: readonly (readonly unknown[])[] = guide.lede
      .concat(guide.sections.flatMap((s) => s.blocks))
      .flatMap((block) =>
        block.kind === "p" ? [block.spans] : block.items.slice()
      );
    const signupSpans = spanRuns
      .flatMap((spans) => spans.slice())
      .filter(
        (span) =>
          typeof span === "object" &&
          span !== null &&
          (span as { href?: string }).href === "/signup"
      );
    expect(signupSpans).toHaveLength(1);

    // The page itself never links to signup — the renderer routes that one
    // span through the island, and the island owns the only <Link>.
    expect(pageSrc(guide.slug)).not.toContain("/signup");
    expect(articleSrc).toMatch(/GuideCtaLink/);
    expect(articleSrc).toMatch(/["']\/signup["']/);
    expect(count(ctaSrc, 'href="/signup"')).toBe(1);
    expect(ctaSrc).toMatch(/<Link\s/);
  });

  it("fires guide_view and guide_cta_click from its rendered tree", () => {
    const tree = treeFor(guide.slug);
    expect(tree).toContain("trackGuideView");
    expect(tree).toContain("trackGuideCtaClick");
    // Both events are attributed by slug, so the slug has to reach the island.
    expect(articleSrc).toMatch(/<GuideViewTracker\s+slug=\{guide\.slug\}/);
    expect(articleSrc).toMatch(/<GuideCtaLink\s[^>]*slug=\{guide\.slug\}/);
    // guide_view fires once per mount, not once per render.
    expect(viewSrc).toMatch(/useRef/);
    expect(viewSrc).toMatch(/useEffect/);
  });

  it("does not fire visit_landing", () => {
    const tree = treeFor(guide.slug);
    expect(tree).not.toContain("visit_landing");
    expect(tree).not.toContain("trackVisitLanding");
  });

  it("server-renders FAQPage JSON-LD from the registry answers", () => {
    const tree = treeFor(guide.slug);
    expect(tree).toContain("application/ld+json");
    expect(tree).toMatch(/["']FAQPage["']/);
    expect(tree).not.toContain("beforeInteractive");
    expect(tree).not.toContain("next/script");
    // Answers are read from the entry, never retyped into the page.
    for (const entry of guide.faq) {
      expect(tree).not.toContain(entry.a);
      expect(tree).not.toContain(entry.q);
    }
    expect(articleSrc).toMatch(/guide\.faq/);
  });

  it("renders the registry prose rather than a second copy of it", () => {
    const tree = treeFor(guide.slug);
    expect(tree).not.toContain(guide.h1);
    expect(tree).not.toContain(guide.footer);
    const firstLede = guide.lede[0];
    if (firstLede.kind === "p") {
      expect(tree).not.toContain(plainText(firstLede.spans));
    }
    for (const section of guide.sections) {
      expect(tree, `inlines heading ${section.heading}`).not.toContain(
        section.heading
      );
    }
  });
});

// AC2's second half. The sitemap half is covered in tests/public-routes.test.ts;
// this is the other one. A URL that is listed in the sitemap and then tells the
// crawler not to index it is worse than a page that was never shipped: it burns
// crawl budget and ranks nothing. Nothing in the build fails on a stray
// `robots: { index: false }`, which is how a debugging line survives to
// production, so the assertion is here.
describe("b-12: no part of a guide's tree tells a crawler to stay away", () => {
  const robotsSrc = stripComments(read("src/app/robots.ts"));

  // Everything whose metadata or markup reaches a guide response: the root
  // layout (metadata is merged, so a noindex there poisons all three), the
  // shared renderer, the two islands, and each route segment.
  const GUIDE_TREE_SOURCES: readonly (readonly [string, string])[] = [
    ["src/app/layout.tsx", layoutSrc],
    [ARTICLE_REL, articleSrc],
    [VIEW_REL, viewSrc],
    [CTA_REL, ctaSrc],
    ...GUIDES.map((g) => [pageRel(g.slug), pageSrc(g.slug)] as const),
  ];

  it("emits no noindex or nofollow directive", () => {
    for (const [label, src] of GUIDE_TREE_SOURCES) {
      expect(src, `${label} emits a noindex/nofollow directive`).not.toMatch(
        /noindex|nofollow/i
      );
    }
  });

  it("never disables indexing through the metadata robots object", () => {
    // The structured form Next also accepts: robots: { index: false } or
    // { follow: false }, which renders the same meta tag as the strings above.
    for (const [label, src] of GUIDE_TREE_SOURCES) {
      expect(src, `${label} sets metadata.robots to non-indexable`).not.toMatch(
        /robots:\s*\{[\s\S]{0,300}?\b(index|follow)\s*:\s*false/
      );
    }
  });

  it("keeps src/app/robots.ts allowing crawlers, and never blocks /guides", () => {
    expect(robotsSrc).toMatch(/userAgent:\s*["']\*["']/);
    expect(robotsSrc).toMatch(/allow:\s*["']\/["']/);
    // A disallow for an app surface such as /dashboard is legitimate, so this
    // fails only on a rule that would cover the site root or the guides.
    const disallowed = [
      ...robotsSrc.matchAll(/disallow:\s*(\[[^\]]*\]|["'][^"']*["'])/gi),
    ].map((m) => m[1]);
    for (const value of disallowed) {
      expect(value, "robots.ts blocks the guides").not.toMatch(
        /["']\/(guides[^"']*)?["']/
      );
    }
  });
});

// AC3's derivation half. The registry stores site-relative canonicals
// ("/guides/fake-pay-stub") and Next resolves them against metadataBase, so
// metadataBase is the single place the origin is decided and the only thing
// worth pinning. Asserting that a page uses guide.canonical (above) does not
// catch an origin hardcoded into the registry or a page reading the env var on
// its own and drifting from the root layout.
//
// The production VALUE is deliberately not asserted here: .github/workflows/ci.yml
// sets NEXT_PUBLIC_SITE_URL=http://localhost:3000 for the job that runs vitest,
// so a "must not be localhost" expectation would ship permanently red. That
// guard lives in scripts/check-analytics-env.mjs, which prebuild runs on the
// production build, where the value is the real one.
describe("b-12: the guide canonical derives from the shared siteUrl", () => {
  it("builds metadataBase from NEXT_PUBLIC_SITE_URL in the root layout", () => {
    expect(layoutSrc).toMatch(
      /const\s+siteUrl\s*=\s*process\.env\.NEXT_PUBLIC_SITE_URL\s*\?\?/
    );
    expect(layoutSrc).toMatch(/metadataBase:\s*new URL\(\s*siteUrl\s*\)/);
  });

  it("keeps every registry canonical a site-relative path", () => {
    for (const guide of GUIDES) {
      expect(guide.canonical).toBe(`/guides/${guide.slug}`);
      expect(guide.canonical).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
    }
  });

  it("hardcodes no origin and re-reads no env var in the registry or pages", () => {
    const registrySrc = stripComments(read("src/lib/guides-copy.ts"));
    const sources: readonly (readonly [string, string])[] = [
      ["src/lib/guides-copy.ts", registrySrc],
      ...GUIDES.map((g) => [pageRel(g.slug), pageSrc(g.slug)] as const),
    ];
    for (const [label, src] of sources) {
      expect(src, `${label} hardcodes an absolute origin`).not.toMatch(
        /https?:\/\//i
      );
      expect(
        src,
        `${label} reads NEXT_PUBLIC_SITE_URL instead of inheriting metadataBase`
      ).not.toContain("NEXT_PUBLIC_SITE_URL");
    }
  });
});
