// b-11 — the landing footer is the only legal/contact surface cold ad traffic
// sees before the signup wall, so the Terms link and the support address have
// to be there and have to agree with src/lib/billing-copy.ts.
//
// This is a source-text test, not a render test: vitest runs with
// environment "node" and the project has no jsdom, and landing-content.tsx is
// a "use client" component. Reading the file is what is available, and it is
// enough to pin the two things that actually regress — the address drifting
// out of sync with the billing copy module, and the links being added
// somewhere other than the footer.

import { readFileSync } from "fs";
import path from "path";
import { expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "..");
const source = readFileSync(
  path.join(repoRoot, "src/components/landing-content.tsx"),
  "utf8",
);

const footerStart = source.indexOf("<footer");
const footerEnd = source.indexOf("</footer>");
const footer = source.slice(footerStart, footerEnd);

it("b-11: the footer region is locatable in the landing source", () =>
  expect(footerStart).toBeGreaterThan(-1));

it("b-11: the footer region is well formed", () =>
  expect(footerEnd).toBeGreaterThan(footerStart));

it("b-11: imports SUPPORT_EMAIL from the billing copy module", () =>
  expect(source).toMatch(
    /import\s*\{[^}]*\bSUPPORT_EMAIL\b[^}]*\}\s*from\s*["']@\/lib\/billing-copy["']/,
  ));

it("b-11: links to the terms page", () =>
  expect(source).toContain('href="/terms"'));

it("b-11: offers the support address as a mailto link", () =>
  expect(source).toContain("mailto:"));

it("b-11: does not hardcode the support address", () =>
  expect(source).not.toContain("admin@draftlabs.org"));

it("b-11: puts the terms link inside the footer, not elsewhere", () =>
  expect(footer).toContain("/terms"));

it("b-11: puts the mailto inside the footer, not elsewhere", () =>
  expect(footer).toContain("mailto:"));

it("b-11: adds no footer link labelled exactly Pricing", () =>
  expect(footer).not.toMatch(/>\s*Pricing\s*</));

it("b-11: adds no footer link labelled exactly Log in", () =>
  expect(footer).not.toMatch(/>\s*Log in\s*</i));
