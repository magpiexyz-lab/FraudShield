// ONE TOKEN FOR THE FILLED-CTA ROLE, ACROSS THE THREE SURFACES THAT HAVE ONE.
//
// Diagnosed 2026-11-06. The landing page filled every call to action with
// --primary while the free-scan panel sitting inside it (#live-demo) and every
// plan CTA on /pricing filled theirs with --signal. On dark those tokens are
// oklch(0.72 0.125 215) and oklch(0.74 0.130 213) -- 0.02 apart in lightness,
// 0.005 in chroma, 2 degrees in hue -- on the same pill radius, for the same
// role, and the nav CTA is co-visible with the panel's button whenever the demo
// section is in frame. That does not read as two colours. It reads as one
// colour rendered badly.
//
// This is a source-text test because vitest runs environment "node" with no
// jsdom, so none of these components can be rendered here (same constraint as
// tests/footer-legal-links.test.ts). Reading the class attributes is what is
// available and it pins the thing that actually regressed: a filled CTA being
// added with the other cyan.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) =>
  readFileSync(path.join(repoRoot, ...p), "utf8");

const LANDING = read("src", "components", "landing-content.tsx");
const PANEL = read("src", "components", "free-scan-panel.tsx");
const PRICING = read("src", "app", "pricing", "pricing-plans.tsx");

/**
 * CODE WITH THE PROSE TAKEN OUT.
 *
 * The negative assertion below bans a token name, and the comment that records
 * WHY it is banned has to be free to say which token it replaced -- otherwise
 * the explanation trips the guard it explains. Block comments go first so that
 * JSX {/* ... *\/} blocks go with them.
 */
const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Class attributes and cn() string arguments, which is where fills live. */
const classStrings = (source: string) => [
  ...(source.match(/className="[^"]*"/g) ?? []),
  ...(source.match(/"[^"\n]*\bbg-[a-z-]+[^"\n]*"/g) ?? []),
];

describe("filled CTA fill token", () => {
  it("the three sources loaded", () => {
    // Positive control: every negative assertion below would pass vacuously
    // against an empty string.
    expect(LANDING.length).toBeGreaterThan(2000);
    expect(PANEL.length).toBeGreaterThan(2000);
    expect(PRICING.length).toBeGreaterThan(1000);
  });

  it("the landing page fills its calls to action with the signal token", () => {
    const filled = classStrings(LANDING).filter((c) => c.includes("bg-signal"));
    // Nav CTA, hero CTA, the Pro plan card CTA and the closing CTA, plus the
    // "Most popular" pill that sits on the same fill.
    expect(filled.length).toBeGreaterThanOrEqual(4);
    for (const c of filled) expect(c).toContain("text-signal-foreground");
  });

  it("the landing page fills nothing with the near-identical primary token", () => {
    // THE GUARD. --primary and --signal are two cyans 0.02 apart on dark, so a
    // new CTA built on --primary would be invisible in review and wrong on
    // screen.
    const code = codeOnly(LANDING);
    // Positive control on the strip: it must not have eaten the markup.
    expect(code).toContain("bg-signal");
    expect(code.length).toBeGreaterThan(LANDING.length * 0.5);

    expect(code).not.toContain("bg-primary");
    expect(code).not.toContain("text-primary-foreground");
  });

  it("does not hand-roll the signal token as a literal fill", () => {
    // oklch(0.74 0.130 213) IS --signal on dark. Spelled out it drifts the
    // moment the token moves, and it was spelled out under the wrong
    // foreground.
    expect(codeOnly(LANDING)).not.toMatch(
      /background:\s*"oklch\(0\.74 0\.130 213\)"/,
    );
  });

  it("the panel and the pricing plans agree with it", () => {
    // The panel renders inside the landing page; /pricing is the surface the
    // landing CTAs lead to. All three now name one token for the same role.
    expect(PANEL).toContain("bg-signal");
    expect(PANEL).toContain("text-signal-foreground");
    expect(PRICING).toContain("bg-signal");
  });
});
