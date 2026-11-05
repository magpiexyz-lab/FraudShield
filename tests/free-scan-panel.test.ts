// The anonymous free-scan panel -- what replaced the canned landing animation
// that converted at 1.1%.
//
// WHY PART OF THIS IS A SOURCE-TEXT TEST. vitest runs environment "node" and
// the project has no jsdom, so a "use client" React component cannot be
// rendered here. That constraint is documented in
// tests/pro-signal-breakdown.test.ts and worked around the same way in
// tests/footer-legal-links.test.ts. The response is NOT to give up on the
// logic: everything that can be wrong independently of the DOM -- the refusal
// code to cap mapping, the partial-verdict predicate, the client-side file
// gate, the teaser sentence, the pre-upload copy -- is exported from the
// component as a pure function or a constant and tested directly.
//
// Only the handful of facts that have no other home are asserted against the
// source text, and each of those guards a specific, already-diagnosed way the
// panel leaks or misleads:
//
//   - SignalBreakdown renders a signal weight as a "+N" chip and a signal id
//     verbatim. On a 2-of-N teaser that prints "87" beside "+5" and "+8",
//     which lets anyone subtract the withheld 74 points off the screen, and
//     it renders AI findings as raw vision_arithmetic_mismatch. So the panel
//     needs its own renderer, showing only label, severity and detail.
//   - ScanningState lives in src/app/dashboard/upload-zone.tsx and is module
//     private. Importing it would drag that module graph into the LANDING
//     PAGE bundle, which is the cold paid-ad entry point.
//   - vision.ts:22-24 makes the pre-upload AI disclosure a hard rule. The
//     landing page has never carried that string.
//
// Every negative assertion below is paired with a positive control, because a
// file that failed to load, or a region that failed to delimit, would make all
// of them pass vacuously.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  CAP_CODE_TO_KIND,
  IDLE_PROMISE,
  capKindForCode,
  isPartialVerdict,
  rejectFileLocally,
  teaserHeadline,
} from "@/components/free-scan-panel";
import { AI_PRIVACY_DISCLOSURE } from "@/lib/fraud/analysis-mode";
import { MAX_ANON_BYTES } from "@/lib/scan-intake";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const PANEL = ["src", "components", "free-scan-panel.tsx"];
const source = read(...PANEL);

/**
 * A signal id has exactly one legitimate use in a list renderer: the React
 * key, which never reaches the screen. Stripping key attributes first is what
 * lets the assertions below ban the identifier outright rather than guessing
 * at JSX text positions -- and the callback parameter name is irrelevant, so
 * renaming "signal" to "s" cannot slip past them.
 */
const withoutReactKeys = source.replace(/key=\{[^}]*\}/g, "");

// ---------------------------------------------------------------------------
// Positive controls. If the panel file ever fails to load, or the strip above
// eats the whole file, these fail FIRST and every negative assertion below is
// known to be meaningful rather than vacuous.
// ---------------------------------------------------------------------------

describe("free-scan panel -- positive controls", () => {
  it("the panel source loaded and is a real component file", () => {
    expect(source.length).toBeGreaterThan(2000);
    expect(source).toContain("\"use client\"");
    expect(source).toContain("export function FreeScanPanel");
  });

  it("the key-stripped copy is still substantially the file", () => {
    // Guards the regex above: had it ever matched greedily across the file,
    // the id bans would pass because there was nothing left to search.
    expect(withoutReactKeys.length).toBeGreaterThan(source.length * 0.9);
  });

  it("the panel posts to the free-scan route", () => {
    // The other half of the vacuity guard: proves the subject of these
    // assertions is the component that actually talks to /api/free-scan.
    expect(source).toContain("/api/free-scan");
  });
});

// ---------------------------------------------------------------------------
// Refusal code to cap kind. trackFreeScanCapped takes "ip" / "site" /
// "unavailable" and the route speaks in codes, so this mapping is the join. A
// wrong entry mislabels an outage as a visitor hitting their own limit.
// ---------------------------------------------------------------------------

describe("free-scan panel -- cap mapping", () => {
  it("maps all three cap codes, and only those three", () => {
    // Totality is enforced in the type system as a Record keyed on
    // FreeScanCapCode minus "ok", which tsc checks. This asserts the RUNTIME
    // keys, so a fourth cap code added to lib/free-scan-cap.ts surfaces here.
    expect(Object.keys(CAP_CODE_TO_KIND).sort()).toEqual([
      "cap_unavailable",
      "ip_capped",
      "site_capped",
    ]);
  });

  it("stays in sync with the cap codes lib/free-scan-cap.ts declares", () => {
    const capSource = read("src", "lib", "free-scan-cap.ts");
    const typeAt = capSource.indexOf("export type FreeScanCapCode");
    const union = capSource.slice(typeAt, capSource.indexOf(";", typeAt));
    const declared = [...union.matchAll(/"([a-z_]+)"/g)]
      .map((m) => m[1])
      .filter((c) => c !== "ok")
      .sort();
    expect(declared.length).toBe(3); // positive control on the parse
    expect(Object.keys(CAP_CODE_TO_KIND).sort()).toEqual(declared);
  });

  it.each([
    ["ip_capped", "ip"],
    ["site_capped", "site"],
    ["cap_unavailable", "unavailable"],
  ] as const)("reads %s as the %s cap", (code, kind) => {
    expect(capKindForCode(code)).toBe(kind);
  });

  it.each([
    "too_many_requests",
    "pdf_not_supported",
    "unsupported_type",
    "empty_file",
    "file_too_large",
    "image_unreadable",
    "not_configured",
    "invalid_request",
  ])("does not treat %s as a cap", (code) => {
    // free_scan_capped carries the budget diagnostic. A 429 for request RATE,
    // or any other refusal, firing it would make "the daily free scans ran
    // out" unreadable.
    expect(capKindForCode(code)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The partial-verdict predicate.
// ---------------------------------------------------------------------------

describe("free-scan panel -- partial verdict predicate", () => {
  // vision_status is the VisionStatus union from lib/fraud/vision.ts:
  // "analyzed" / "inconclusive" / "unavailable". The predicate compares
  // against "analyzed".
  //
  // THE PLAN SPECIFIED A COMPARISON AGAINST "ok". That string is not a member
  // of the union, so the comparison is true for EVERY scan including a fully
  // analyzed one, and the panel would have shown "Partial analysis" on every
  // success. A test written against the planned predicate would have passed
  // VACUOUSLY: the "inconclusive" and "unavailable" cases hold under either
  // version, so the "analyzed" case below is the only one that can tell them
  // apart. It is the whole test.
  it("is false for a completed AI pass", () => {
    expect(isPartialVerdict("analyzed")).toBe(false);
  });

  it("is true when the model looked and could not tell", () => {
    expect(isPartialVerdict("inconclusive")).toBe(true);
  });

  it("is true when the pass never completed", () => {
    expect(isPartialVerdict("unavailable")).toBe(true);
  });

  it("is true for a status it has never seen", () => {
    // Fails safe: an unrecognised status means nothing confirmed the content
    // was read, and a metadata-only verdict must never present as a delivered
    // scan. "ok" lands here, which turns the planned predicate bug into a
    // harmless default rather than a silent one.
    expect(isPartialVerdict("ok")).toBe(true);
    expect(isPartialVerdict("")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The teaser sentence. The paywall is a COUNT, never arithmetic.
// ---------------------------------------------------------------------------

describe("free-scan panel -- teaser headline", () => {
  it("names the full count and how many are shown", () => {
    expect(teaserHeadline(6, 2)).toBe(
      "6 forensic signals found on this document \u2014 2 shown",
    );
  });

  it("agrees in number when only one signal was found", () => {
    expect(teaserHeadline(1, 1)).toBe(
      "1 forensic signal found on this document \u2014 1 shown",
    );
  });

  it("carries no weighted-sum language", () => {
    // Nothing this surface says may make the withheld points derivable.
    for (const total of [1, 2, 3, 6, 11]) {
      const line = teaserHeadline(total, Math.min(2, total));
      expect(line).not.toMatch(/point|weight|score|\+\d/i);
    }
  });
});

// ---------------------------------------------------------------------------
// The client-side gate. Mirrors the server, never replaces it.
// ---------------------------------------------------------------------------

const asFile = (type: string, size: number) =>
  ({ type, size }) as Pick<File, "type" | "size">;

describe("free-scan panel -- client-side file gate", () => {
  it("accepts a JPEG within the cap", () => {
    expect(rejectFileLocally(asFile("image/jpeg", 1024))).toBeNull();
  });

  it("frames a PDF as a signup prompt, not a dead end", () => {
    // PDFs ARE supported by the product, just not for free. Same code the
    // route uses, so the two surfaces cannot drift apart in their framing.
    expect(rejectFileLocally(asFile("application/pdf", 1024))?.code).toBe(
      "pdf_not_supported",
    );
  });

  it("refuses a non-image outright", () => {
    expect(rejectFileLocally(asFile("text/plain", 1024))?.code).toBe(
      "unsupported_type",
    );
  });

  it("refuses a blank MIME type", () => {
    // The route diverges from /api/scan here on purpose: a blank-type PDF
    // treated as an image fails EXIF extraction into missing_exif_metadata
    // and hands back a confident verdict on a document nothing read. The
    // client must not be laxer than the server it mirrors.
    expect(rejectFileLocally(asFile("", 1024))?.code).toBe("unsupported_type");
  });

  it("refuses an empty file", () => {
    expect(rejectFileLocally(asFile("image/png", 0))?.code).toBe("empty_file");
  });

  it("accepts a file of exactly MAX_ANON_BYTES", () => {
    expect(rejectFileLocally(asFile("image/png", MAX_ANON_BYTES))).toBeNull();
  });

  it("refuses one byte over MAX_ANON_BYTES", () => {
    // This pair pins the boundary to the imported constant: move
    // MAX_ANON_BYTES and both still hold, retype the number locally and they
    // diverge the moment the shared one changes.
    expect(
      rejectFileLocally(asFile("image/png", MAX_ANON_BYTES + 1))?.code,
    ).toBe("file_too_large");
  });

  it("gives every refusal copy written for a stranger", () => {
    for (const f of [
      asFile("application/pdf", 10),
      asFile("text/plain", 10),
      asFile("image/png", 0),
      asFile("image/png", MAX_ANON_BYTES + 1),
    ]) {
      const message = rejectFileLocally(f)?.message ?? "";
      expect(message.length).toBeGreaterThan(20);
      expect(message).not.toMatch(/undefined|null|\[object/i);
    }
  });

  it("takes both limits from lib/scan-limits rather than retyping them", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bANON_ACCEPTED_MIME\b[^}]*\}\s*from\s*"@\/lib\/scan-limits"/,
    );
    expect(source).toMatch(
      /import\s*\{[^}]*\bMAX_ANON_BYTES\b[^}]*\}\s*from\s*"@\/lib\/scan-limits"/,
    );
    expect(source).not.toContain("4194304");
    expect(source).not.toMatch(/4\s*\*\s*1024/);
  });

  // KEEPS exifr OUT OF THE LANDING-PAGE BUNDLE. lib/scan-intake.ts re-exports
  // the same four constants and does a top-level `import exifr from "exifr"`
  // for extractImageMetadata. Webpack drops the unused exports either way, but
  // it only drops that exifr import if the package declares
  // `sideEffects: false`, which could not be verified. This component ships in
  // the bundle the paid ads land on, so it reads the limits from
  // lib/scan-limits.ts, which has no imports at all
  // (tests/scan-limits.test.ts enforces that).
  it("does not import lib/scan-intake, which would pull exifr toward the bundle", () => {
    // Comment lines are stripped, because the panel carries a comment NAMING
    // both scan-intake and exifr to explain why it reads from scan-limits
    // instead. The ban is on the import, not on the explanation.
    const NL = String.fromCharCode(10);
    const code = source
      .split(NL)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join(NL);
    // Positive control: the strip left the import block intact.
    expect(code).toMatch(/from\s*"@\/lib\/scan-limits"/);
    expect(code).not.toMatch(/from\s*"@\/lib\/scan-intake"/);
    expect(code).not.toContain("exifr");
  });
});

// ---------------------------------------------------------------------------
// The signup exits are counted
//
// The panel has two signup CTAs -- one under a verdict ("See all N signals")
// and one under a cap ("Create a free account"). Both are real landing-page
// exits, and both fired NOTHING, so h-01 (cta_click / visit_landing)
// understated this surface: a visitor who scanned, saw a withheld count and
// clicked through was invisible in the demand numerator while still counted in
// the reach denominator.
//
// The assertion is a RATIO, not a call count: every /signup link in this file
// must have a trackCtaClick beside it. That is what catches a THIRD signup CTA
// added later without tracking, which is the failure mode that produced this
// task.
// ---------------------------------------------------------------------------

describe("free-scan panel -- signup CTAs fire cta_click", () => {
  const codeOnly = (() => {
    const NL = String.fromCharCode(10);
    return source
      .split(NL)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join(NL);
  })();

  it("imports the typed wrapper rather than calling the provider", () => {
    // Rule 2: never the analytics provider directly, always the typed wrapper.
    expect(source).toMatch(
      /import\s*\{[^}]*\btrackCtaClick\b[^}]*\}\s*from\s*"@\/lib\/events"/,
    );
  });

  it("fires one cta_click per signup link, and carries the variant", () => {
    const signupLinks = codeOnly.match(/href="\/signup"/g) ?? [];
    const ctaCalls = codeOnly.match(/trackCtaClick\(/g) ?? [];
    // Positive control: both CTAs still exist. A panel that lost its signup
    // links would satisfy a bare equality with zero on each side.
    expect(signupLinks.length).toBeGreaterThanOrEqual(2);
    expect(ctaCalls.length).toBe(signupLinks.length);
    // Same property the four landing CTAs send (landing-content.tsx), so the
    // panel's exits can be read per variant alongside them.
    expect(codeOnly).toMatch(/trackCtaClick\(\{\s*variant\s*\}\)/);
  });

  it("gives the verdict-state CTA the variant to send", () => {
    // The teaser CTA lives in a child component. Without the prop threaded
    // through, the only way to make it compile is to drop the property, and an
    // unattributed click cannot be read against the variant that produced it
    // -- which is the entire reason this surface is instrumented.
    expect(codeOnly).toMatch(/function Teaser\(\{[\s\S]{0,160}variant/);
    expect(codeOnly).toMatch(/function ResultView\(\{[\s\S]{0,160}variant/);
  });
});

// ---------------------------------------------------------------------------
// cta_click now has a fifth trigger site, and EVENTS.yaml has to say so
//
// Rule 2 makes experiment/EVENTS.yaml canonical. The event's population
// changed the moment the panel started firing it, so rates measured before and
// after are not strictly comparable -- exactly the situation checkout_started
// already documents in its own trigger. An undated widening is how a funnel
// step appears to improve because its numerator quietly grew a new source.
// ---------------------------------------------------------------------------

describe("cta_click declares its population change", () => {
  /**
   * The cta_click block as raw text, delimited the way
   * tests/checkout-abandon-reason.test.ts delimits its event: by the next key
   * indented exactly two spaces, which is the next EVENT rather than a
   * property of this one. Read as text, not parsed -- js-yaml is only a
   * transitive dependency of this project.
   */
  function ctaClickBlock(): string {
    const NL = String.fromCharCode(10);
    const lines = read("experiment", "EVENTS.yaml").split(NL);
    const start = lines.findIndex((l) => l.startsWith("  cta_click:"));
    if (start === -1) return "";
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      const twoSpaceKey =
        l.length > 2 &&
        l[0] === " " &&
        l[1] === " " &&
        l[2] !== " " &&
        l.trimEnd().endsWith(":");
      if (twoSpaceKey) {
        end = i;
        break;
      }
    }
    return lines.slice(start, end).join(NL);
  }

  it("delimits the block, so the assertions below are not vacuous", () => {
    const block = ctaClickBlock();
    expect(block).toContain("funnel_stage: demand");
    expect(block).toContain("trigger:");
    // guide_cta_click is the next event. Catching it here would mean the
    // delimiter ran long and the assertions are reading someone else's block.
    expect(block).not.toContain("guide_cta_click:");
  });

  it("records the change, with a date, in the checkout_started shape", () => {
    const block = ctaClickBlock();
    expect(block).toContain("POPULATION CHANGED");
    expect(block).toMatch(/POPULATION CHANGED 20\d\d-\d\d-\d\d/);
    // Whitespace-tolerant: the phrase wraps across a line in the block
    // scalar, exactly as it does in checkout_started.
    expect(block).toMatch(/not\s+(?:strictly\s+)?comparable/);
  });

  it("names the free-scan panel as the new trigger site", () => {
    expect(ctaClickBlock()).toMatch(/free[- ]scan/i);
  });

  // OUT OF SCOPE ON PURPOSE. Telling the five CTAs apart wants a `surface`
  // property, the way checkout_started and paywall_shown have one -- but that
  // is a wider schema change touching four existing call sites, and adding it
  // to the declaration alone would declare a property nothing sends.
  it("adds no new property to the event", () => {
    const block = ctaClickBlock();
    expect(block).toContain("variant:");
    expect(block).not.toContain("surface:");
  });
});

// ---------------------------------------------------------------------------
// Pre-upload state. Both hard requirements are asserted on exported copy or on
// an import, rather than grepped out of a JSX blob.
// ---------------------------------------------------------------------------

describe("free-scan panel -- before upload", () => {
  it("promises a fraud score in those words", () => {
    // An e2e assertion requires the phrase visible on a bare / with no
    // interaction. ScoreGauge renders "Fraud score" itself, but no gauge
    // exists until a scan returns, so the promise has to live in idle copy.
    expect(IDLE_PROMISE).toMatch(/fraud score/i);
  });

  it("says how much of the result the free scan hands over", () => {
    expect(IDLE_PROMISE).toMatch(/\btwo\b|\b2\b/i);
  });

  it("renders the shared AI privacy disclosure, not a local paraphrase", () => {
    // vision.ts:22-24 makes pre-upload disclosure a hard rule, and the
    // dashboard already discloses at upload-zone.tsx:562-565. The landing
    // page carried no such string before this panel.
    expect(AI_PRIVACY_DISCLOSURE).toMatch(/Anthropic/);
    expect(AI_PRIVACY_DISCLOSURE.toLowerCase()).toContain("no document is stored");
    expect(source).toMatch(
      /import\s*\{[^}]*\bAI_PRIVACY_DISCLOSURE\b[^}]*\}\s*from\s*"@\/lib\/fraud\/analysis-mode"/,
    );
    expect(source).toContain("{AI_PRIVACY_DISCLOSURE}");
  });

  it("uses the shared limited-analysis copy for a metadata-only verdict", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bLIMITED_ANALYSIS_TITLE\b[^}]*\}\s*from\s*"@\/lib\/fraud\/analysis-mode"/,
    );
    expect(source).toContain("LIMITED_ANALYSIS_BODY");
  });
});

// ---------------------------------------------------------------------------
// What the panel may import, and which fields of a signal may reach a reader.
// ---------------------------------------------------------------------------

describe("free-scan panel -- imports and signal rendering", () => {
  it("reuses the real score gauge", () => {
    // Its band labels -- Authentic / Needs review / Likely forged -- are the
    // only ones anyone has seen on a real score. A second set here would make
    // the free verdict and the paid one disagree in words.
    expect(source).toMatch(
      /import\s*\{[^}]*\bScoreGauge\b[^}]*\}\s*from\s*"@\/app\/scan-result\/score-gauge"/,
    );
  });

  it("does not import SignalBreakdown", () => {
    expect(source).not.toContain("SignalBreakdown");
    expect(source).not.toContain("signal-breakdown");
  });

  it("does not import anything from the dashboard upload zone", () => {
    // ScanningState is module private there, and importing it pulls that
    // module graph -- including a type import from the scan route -- into the
    // cold paid-ad entry bundle.
    expect(source).not.toContain("dashboard/upload-zone");
    expect(source).not.toContain("ScanningState");
  });

  it("never renders a signal weight", () => {
    // Banned outright: there is no legitimate use of a weight in this file,
    // and printing one next to the score is what lets the withheld points be
    // read off the screen.
    expect(source).not.toMatch(/\.weight\b/);
  });

  it("never renders a signal id", () => {
    // React keys are stripped first, so this bans the identifier in every
    // position that reaches a reader -- which is where a raw
    // vision_arithmetic_mismatch would otherwise surface.
    expect(withoutReactKeys).not.toMatch(/\bsignal\.id\b/);
    expect(withoutReactKeys).not.toMatch(/\bs\.id\b/);
  });

  it("renders label, severity and detail -- the whole of what is allowed", () => {
    // Positive control for the two bans above: proves the panel really does
    // render signals, so "no weight" constrains a renderer that exists rather
    // than describing an absent one.
    expect(source).toMatch(/\.label\b/);
    expect(source).toMatch(/\.detail\b/);
    expect(source).toMatch(/\.severity\b/);
  });
});

// ---------------------------------------------------------------------------
// Analytics. The funnel-corrupting mistake is firing activate for someone who
// has not signed up.
// ---------------------------------------------------------------------------

describe("free-scan panel -- analytics", () => {
  it("fires the three free-scan events and the cap paywall", () => {
    for (const fn of [
      "trackFreeScanStart",
      "trackFreeScanComplete",
      "trackFreeScanCapped",
      "trackPaywallShown",
    ]) {
      expect(source).toContain(fn);
    }
  });

  it("never fires activate from an anonymous surface", () => {
    // activate means a signed-up user reached value, and it sits in the
    // golden path. Firing it for an anonymous visitor moves the activation
    // rate without anyone activating.
    expect(source).not.toContain("trackActivate");
  });

  it("fires paywall_shown with the free-scan cap surface", () => {
    expect(source).toContain("\"free_scan_cap\"");
  });

  it("guards the paywall event with a fire-once ref", () => {
    // Same pattern as LockedSignals at scan-result-client.tsx:727-732. The
    // measurement is checkout_start over paywall_shown, so a per-render emit
    // destroys the denominator the event exists to supply.
    expect(source).toMatch(/useRef\(false\)/);
  });

  it("starts the scan event on submit, not on view or on file select", () => {
    // free_scan_start is the h-02 numerator and counts ATTEMPTS. Firing it on
    // mount would count impressions instead and make the completion rate
    // meaningless.
    const beforeFirstStart = source.slice(
      0,
      source.indexOf("trackFreeScanStart({"),
    );
    expect(beforeFirstStart).toContain("async function submit");
  });

  it("reports the token counts the anonymous scan cost", () => {
    // Nothing is persisted for an anonymous scan, so free_scan_complete is
    // the only record of what the free tier spends.
    expect(source).toContain("input_tokens");
    expect(source).toContain("output_tokens");
  });
});

// ---------------------------------------------------------------------------
// Motion and accessibility.
// ---------------------------------------------------------------------------

describe("free-scan panel -- motion and accessibility", () => {
  it("honours prefers-reduced-motion", () => {
    expect(source).toContain("prefers-reduced-motion");
  });

  it("keeps the live regions mounted and toggles visibility by class", () => {
    // WCAG 4.1.3: a live region that mounts at the same moment its content
    // appears is not announced. upload-zone.tsx solves it with sr-only, and
    // the same approach is the one copied here.
    expect(source).toContain("role=\"alert\"");
    expect(source).toContain("aria-live=\"assertive\"");
    expect(source).toContain("role=\"status\"");
    expect(source).toContain("sr-only");
  });
});
