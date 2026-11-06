import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Why this exists.
//
// The landing page's stat band renders three market figures through
// NumberTicker. It used to initialise its state to 0 and reach the real number
// only inside an effect — and effects do not run without JavaScript. So the
// server-rendered HTML, which is what a crawler or a directory reviewer reads,
// said "~0x" and "1 in 0" with a source citation under each. Reported by the
// manager ahead of submitting FraudShield to directories.
//
// vitest runs environment "node" with no jsdom, so the component cannot be
// rendered here. These are source assertions, deliberately narrow: they pin the
// one property that decides whether the figure survives without JavaScript —
// that the ticker's initial state is the real value, and that the rewind to 0
// happens in a before-paint effect rather than being the starting point.
//
// The behavioural proof lives in e2e/stats-no-js.spec.ts, which loads the page
// with JavaScript disabled and reads the actual numbers.

const SRC = readFileSync(
  join(__dirname, "..", "src", "components", "landing-content.tsx"),
  "utf-8",
);

/** Source with comments stripped, so prose explaining a pattern cannot satisfy
 *  an assertion about the code using it. */
const codeOnly = (() => {
  const noBlock = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
  const noLine = noBlock
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");
  return noLine;
})();

describe("landing stat counters survive without JavaScript", () => {
  // Positive control: every assertion below is a substring check over a file
  // read from disk. If the path or the strip were wrong they would all pass or
  // all fail for the wrong reason.
  it("is reading the real component source", () => {
    expect(SRC.length).toBeGreaterThan(10_000);
    expect(codeOnly.length).toBeGreaterThan(SRC.length * 0.3);
    expect(codeOnly).toContain("function NumberTicker");
    expect(codeOnly).toContain("usePrefersReducedMotion");
  });

  it("initialises the displayed figure to the real value, not 0", () => {
    // This is the fix. useState(0) is what shipped "1 in 0".
    expect(codeOnly).toContain("useState(value)");
    expect(codeOnly).not.toMatch(/const \[display, setDisplay\] = useState\(0\)/);
  });

  it("rewinds to 0 in a before-paint effect, so the figure never flashes", () => {
    // Rewinding in a plain useEffect would paint the real number first and then
    // visibly jump back to 0 — worse than no animation at all.
    expect(codeOnly).toContain("useBeforePaintEffect");
    expect(codeOnly).toContain("setDisplay(0)");
  });

  it("picks the layout effect only on the client", () => {
    // useLayoutEffect warns during SSR, so the alias has to fall back.
    expect(codeOnly).toMatch(
      /typeof window === "undefined"\s*\?\s*useEffect\s*:\s*useLayoutEffect/,
    );
  });

  it("still short-circuits for reduced motion before rewinding", () => {
    // Under reduced motion the number must simply stay correct — the rewind
    // must sit after that early return, not before it.
    const body = codeOnly.slice(codeOnly.indexOf("useBeforePaintEffect"));
    const earlyReturn = body.indexOf("reduced || typeof IntersectionObserver");
    const rewind = body.indexOf("setDisplay(0)");
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(rewind).toBeGreaterThan(earlyReturn);
  });

  it("keeps a figure for every stat in the band", () => {
    // Guards against a stat losing its value prop and silently rendering blank.
    const band = SRC.slice(SRC.indexOf("const STATS"));
    const values = band.match(/value:\s*\d+/g) ?? [];
    expect(values.length).toBeGreaterThanOrEqual(3);
    expect(values.every((v) => !/value:\s*0\b/.test(v))).toBe(true);
  });
});
