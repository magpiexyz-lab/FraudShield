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
  PARTIAL_CAUSE,
  rejectFileLocally,
  teaserHeadline,
} from "@/components/free-scan-panel";
import {
  AI_PRIVACY_DISCLOSURE,
  LIMITED_ANALYSIS_BODY,
} from "@/lib/fraud/analysis-mode";
import { MAX_ANON_BYTES } from "@/lib/scan-intake";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const PANEL = ["src", "components", "free-scan-panel.tsx"];
const source = read(...PANEL);

const countOf = (hay: string, needle: string) =>
  hay.split(needle).length - 1;


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

  // REPOINTED 2026-11-05, and the direction is now the opposite one. This
  // assertion used to require the panel to SEND input_tokens / output_tokens,
  // on the reasoning that nothing is persisted for an anonymous scan so
  // free_scan_complete was the only record of what the free tier spends. The
  // route could only supply them by shipping its billing telemetry and the
  // model name to an unauthenticated caller, so the counts came off the wire
  // and off this event; /api/free-scan logs them server-side instead
  // (route.ts step 12, asserted in tests/free-scan-route.test.ts (d2)) and
  // experiment/EVENTS.yaml no longer declares them.
  it("sends no token counts and no model name with the completion event", () => {
    // CODE ONLY, same stripping the cta_click suite below uses. A text guard
    // cannot tell a call from a sentence, and the panel's own comment has to
    // be free to explain which properties were removed and why -- the first
    // version of this assertion failed on that comment.
    const NL = String.fromCharCode(10);
    const codeOnly = source
      .split(NL)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join(NL);

    // POSITIVE CONTROL: the event is still fired with the properties h-12 and
    // the verdict read, so this cannot pass on a panel that tracks nothing.
    expect(codeOnly).toContain("trackFreeScanComplete({");
    expect(codeOnly).toMatch(/band:\s*data\.severity/);
    expect(codeOnly).toMatch(/signal_count:\s*data\.total_signal_count/);

    expect(codeOnly).not.toMatch(/input_tokens:/);
    expect(codeOnly).not.toMatch(/output_tokens:/);
    expect(codeOnly).not.toMatch(/model:\s*data\./);
    // The wire shape carries no `usage` at all now, so nothing in here can
    // read one.
    expect(codeOnly).not.toMatch(/data\.usage/);
  });
});

// ---------------------------------------------------------------------------
// The height reservation, and the thing it is not.
//
// DIAGNOSED 2026-11-06. The content area carried an unconditional
// min-h-[24rem] under a comment claiming the verdict would replace the drop
// well "instead of pushing the rest of the page down". 24rem is 384px and the
// idle well is 449px at 412px wide, so the floor was below every state it was
// meant to hold: the frame shrank 65px when a scan started and then grew 599px
// when the verdict landed, scoring 0.2537 CLS at 412x823 with the panel in
// frame. The reservation now starts at the PICK -- inside the 500ms window
// Chrome discards shifts in -- and is held through whatever comes back, so the
// verdict renders into space that is already taken.
//
// These assertions read the source because vitest runs environment "node" with
// no jsdom; what they pin is the part that silently regressed last time, which
// is a floor that does not cover the states it is applied to.
// ---------------------------------------------------------------------------

describe("free-scan panel -- the height reservation", () => {
  // The reservation's own note has to be free to quote the dead floor it
  // replaced, so the bans below read code with the prose taken out.
  const NL = String.fromCharCode(10);
  const reservationCode = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(NL)
    .filter((l) => !/^\s*\/\//.test(l))
    .join(NL);

  it("still has a content area to reserve", () => {
    // Positive control for the three bans below.
    expect(reservationCode).toContain("px-5 py-6 sm:px-6 sm:py-7");
    // This file is 42% prose by weight, so the strip legitimately removes
    // most of it; the floor is here to catch a strip that ate the code too.
    expect(reservationCode.length).toBeGreaterThan(source.length * 0.3);
  });

  it("reserves one height, and reserves it from the pick", () => {
    expect(countOf(reservationCode, "min-h-[38rem]")).toBe(1);
    // Keyed off the state, with idle the one state excluded: a reservation
    // that also applied at idle would be the empty-slab drop target, and one
    // applied only at the verdict would reserve nothing, which is the defect.
    expect(reservationCode).toMatch(
      /state\.kind === "idle" \? "" : " min-h-\[38rem\]"/,
    );
  });

  it("does not carry a floor below the states it applies to", () => {
    // THE GUARD. 24rem = 384px sits under the idle well (449px at 412px wide,
    // 510px at 360px), so it could not hold anything; any floor shorter than
    // the idle well makes the frame shrink on the pick.
    expect(reservationCode).not.toContain("min-h-[24rem]");
    expect(reservationCode).not.toMatch(/min-h-\[(?:[0-9]|1[0-9]|2[0-9])rem\]/);
  });
});

// ---------------------------------------------------------------------------
// Motion and accessibility.
// ---------------------------------------------------------------------------

describe("free-scan panel -- motion and accessibility", () => {
  it("honours prefers-reduced-motion", () => {
    expect(source).toContain("prefers-reduced-motion");
  });

  // -------------------------------------------------------------------------
  // The focus ring has to actually paint.
  //
  // DIAGNOSED 2026-11-05. All three signal-filled CTAs carried
  // `focus-visible:ring-2` in the class layer AND
  // `style={{ boxShadow: "var(--shadow-signal-glow)" }}` inline. Tailwind
  // implements ring-* as box-shadow, an inline style always beats the class
  // layer, and `focus-visible:outline-none` had already removed the UA
  // fallback -- so keyboard focus changed ZERO pixels on the primary control
  // of a paid-ad landing page, while the resting glow made the button read as
  // permanently highlighted. The glow now lives in the class layer, where
  // ring-2 composes with it instead of losing to it.
  // -------------------------------------------------------------------------

  it("carries the signal glow in the class layer, never inline", () => {
    // POSITIVE CONTROLS. Three filled CTAs (the idle Select-an-image button,
    // the refusal/cap account link and the teaser account link) plus the two
    // underlined reset links is five focusable controls, all five of which
    // declare a ring. If this file ever failed to load, or the CTAs were
    // restructured away, these fail before the negative does.
    expect(countOf(source, "focus-visible:ring-2")).toBe(5);
    expect(countOf(source, "shadow-[var(--shadow-signal-glow)]")).toBe(3);

    // THE GUARD. The glow must never return as an inline style, under any
    // spelling: inline wins over the class layer, so a ring declared beside
    // it is dead code.
    expect(source).not.toMatch(/boxShadow:\s*"var\(--shadow-signal-glow\)"/);
    expect(source).not.toMatch(/style=\{\{[^}]*--shadow-signal-glow/);

    // And more generally: every inline box-shadow left in the file is an
    // `inset` hairline on an aria-hidden decoration. A non-inset inline
    // box-shadow is the shape of the bug, so ban that rather than ban the
    // property -- the two survivors are legitimate and must keep working.
    const inlineShadows = source.match(/boxShadow:[^;]*?inset/g) ?? [];
    expect(inlineShadows.length).toBe(2);
    expect(countOf(source, "boxShadow:")).toBe(2);
  });

  it("pairs the glow with a ring on the same element", () => {
    // A glow in the class layer is only half the fix: the ring has to be on
    // the same className, or focus still changes nothing. Checked per
    // attribute rather than file-wide.
    const classNames = source.match(/className="[^"]*"/g) ?? [];
    const glowing = classNames.filter((c) =>
      c.includes("shadow-[var(--shadow-signal-glow)]"),
    );
    expect(glowing.length).toBe(3);
    for (const c of glowing) {
      expect(c).toContain("focus-visible:ring-2");
      expect(c).toContain("focus-visible:ring-[var(--ring)]");
      // The ring needs an offset to clear the glow's own 1px spread ring,
      // and an offset colour, or it draws against the wrong ground.
      expect(c).toContain("focus-visible:ring-offset-2");
      expect(c).toMatch(/focus-visible:ring-offset-(card|\[oklch)/);
    }
  });

  it("offsets each focus ring against the surface actually behind it", () => {
    // RAISED AS AN INCONSISTENCY AND DECLINED, 2026-11-06; the reasoning sits
    // beside the button in the component so the next scan does not re-raise
    // it. The report held that all three filled CTAs sit on the card and that
    // the idle one therefore named the wrong offset ground. It does not sit on
    // the card: it is a child of the recessed well, whose fill is set inline a
    // few lines above it, and the well measures 1.12:1 against the card. One
    // offset colour shared by all three would be wrong for whichever two it
    // did not describe.
    expect(
      countOf(source, "focus-visible:ring-offset-[oklch(0.16_0.02_252)]"),
    ).toBe(1);
    expect(countOf(source, "focus-visible:ring-offset-card")).toBe(2);
    // Positive control: the one offset colour spelled out as a literal is the
    // well's actual fill, so the pair above cannot drift apart silently.
    expect(source).toContain("background: \"oklch(0.16 0.02 252)\"");
  });

  it("names the region with a constant, not with the state word", () => {
    // The h3 cycles Free scan -> Analyzing -> Verdict -> Not scanned, so
    // landmark and heading navigation announced this region as a transient
    // state. aria-labelledby is resolved BEFORE aria-label in the
    // accessible-name computation, so the fix is only real if the former is
    // gone -- keeping both would have changed nothing.
    // CODE ONLY. The same stripping the token-count suite below uses, and for
    // the same reason: the attribute's own explanatory comment has to be free
    // to NAME the attribute it removed. The first version of this assertion
    // failed on exactly that comment.
    const NL = String.fromCharCode(10);
    const codeOnly = source
      .split(NL)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join(NL);

    expect(codeOnly).toContain('aria-label="Free document scan"');
    expect(codeOnly).not.toContain("aria-labelledby");
  });

  it("keeps the resting drop-well edge above the 3:1 non-text threshold", () => {
    // MEASURED against the well's own fill, oklch(0.16 0.02 252). At 22%
    // alpha the dashed edge was 1.77:1 and the well itself is 1.12:1 against
    // the card, so nothing marked the boundary. 42% measures 3.47:1 against
    // the well and 3.11:1 against the card. The recess is the BACKGROUND,
    // which is unchanged -- so this is a floor on the border alpha, and
    // lowering it to soften the look is the regression.
    const m = source.match(/: "oklch\(0\.92 0\.02 220 \/ (\d+)%\)"/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(42);
    // POSITIVE CONTROL: the drag state still swaps to the signal colour,
    // which measures 8.79:1 against the well and is the whole reason the
    // resting edge is allowed to stay quiet.
    expect(source).toContain('? "var(--signal)"');
    expect(source).toContain('background: "oklch(0.16 0.02 252)"');
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
// ---------------------------------------------------------------------------
// The panel and the route have to describe the same product.
// ---------------------------------------------------------------------------

describe("free-scan panel -- refusal copy agrees with the route", () => {
  const routeSource = read("src", "app", "api", "free-scan", "route.ts");

  /** The panel escapes its em dash; the route types one. Same sentence. */
  const EMDASH = String.fromCharCode(8212);
  const normalize = (s: string) => s.split("\\u2014").join(EMDASH);

  const pdfLine = (src: string) => {
    const m = src.match(/"PDF scanning comes with a free account[^"]*"/);
    expect(m).not.toBeNull();
    return normalize(m![0]);
  };

  it("offers every format the gate actually accepts", () => {
    // ANON_ACCEPTED_MIME is ACCEPTED_MIME filtered to image/*, so WebP IS
    // accepted -- and the PDF refusal, the likeliest refusal after HEIC, said
    // "JPEG and PNG images" while the chips below the drop well said WEBP and
    // the unsupported-type refusal said WebP as well. Three lists, and the
    // most-seen one understated the product.
    for (const src of [source, routeSource]) {
      expect(pdfLine(src)).toContain("JPEG, PNG and WebP images");
    }
    // POSITIVE CONTROLS: the other two lists, which were already right.
    expect(source).toContain("Upload a JPEG, PNG or WebP image");
    expect(source).toContain('["JPG", "PNG", "WEBP"]');
  });

  it("keeps the two copies of the PDF refusal word-identical", () => {
    // LOCAL_REFUSALS exists only to save a round trip, so a visitor must not
    // be able to tell which side refused them. The panel's own docstring
    // requires this; nothing enforced it until now.
    expect(pdfLine(source)).toBe(pdfLine(routeSource));
  });

  it("keeps the PDF refusal signup-framed", () => {
    // SIGNUP_FRAMED_CODES puts an account CTA under this message, so the copy
    // has to go on offering one.
    expect(pdfLine(source)).toMatch(/free account/);
    expect(pdfLine(source)).toMatch(/Sign up/);
  });
});

// ---------------------------------------------------------------------------
// A partial verdict has to explain the limitation it actually hit.
// ---------------------------------------------------------------------------

describe("free-scan panel -- partial verdict copy", () => {
  it("names the cause instead of only restating the shared ceiling", () => {
    // isPartialVerdict is true when the CONTENT pass did not complete. The
    // shared LIMITED_ANALYSIS_BODY is about images versus PDFs, which is true
    // of every scan on this surface including the fully analysed ones -- so
    // on its own it told a visitor whose pass timed out to go find a PDF.
    expect(PARTIAL_CAUSE.toLowerCase()).toContain("did not finish");
    expect(PARTIAL_CAUSE.toLowerCase()).toContain("ai content review");
    expect(PARTIAL_CAUSE).not.toBe(LIMITED_ANALYSIS_BODY);
    // Not a second wording of the shared claim: it must not relitigate PDFs
    // or what a full scan adds.
    expect(PARTIAL_CAUSE.toLowerCase()).not.toContain("pdf");
    expect(PARTIAL_CAUSE.toLowerCase()).not.toContain("forensics");
    // POSITIVE CONTROL on the shared string being the one that owns that
    // claim, so the split above is real.
    expect(LIMITED_ANALYSIS_BODY.toLowerCase()).toContain("pdf");
  });

  it("renders the cause above the shared copy, and still renders the shared copy", () => {
    const cause = source.indexOf("{PARTIAL_CAUSE}");
    const shared = source.indexOf("{LIMITED_ANALYSIS_BODY}");
    expect(cause).toBeGreaterThan(-1);
    expect(shared).toBeGreaterThan(-1);
    expect(cause).toBeLessThan(shared);
  });
});

// ---------------------------------------------------------------------------
// The shared score gauge, which this PR is what puts on the landing page.
// ---------------------------------------------------------------------------

describe("score gauge -- announced once, and legible", () => {
  const gauge = read("src", "app", "scan-result", "score-gauge.tsx");

  it("does not announce the score twice", () => {
    // POSITIVE CONTROL: the svg label is the one announcement, and it carries
    // both the number and the band word.
    expect(gauge).toContain('role="img"');
    expect(gauge).toContain("aria-label={`Fraud score ${score} out of 100,");
    // The centre readout is a SIBLING of that svg, not a child, so without
    // aria-hidden the tree held "Fraud score", the number and the band word a
    // second time.
    expect(gauge).toContain(
      '<div aria-hidden="true" className="absolute inset-0 flex flex-col items-center justify-center">',
    );
  });

  it("keeps the ticking number out of any live region", () => {
    // aria-hidden on the readout is only safe while the count-up is not
    // announced on its own. If a live region ever lands on this component the
    // hidden number becomes a silent one.
    expect(gauge).not.toContain("aria-live");
    expect(gauge).not.toContain('role="status"');
    expect(gauge).not.toContain('role="alert"');
    expect(gauge).toContain("<NumberTicker");
  });

  it("keeps the verdict pill above 4.5:1 by keeping the tint low", () => {
    // MEASURED. Pill text and pill tint are the SAME severity colour, and
    // every severity colour is lighter than the card behind it, so raising
    // the mix moves the background toward the text: fraud measured 4.39:1 at
    // 14% and only 4.06:1 at 20%. At 10% it is 4.60:1 (suspect 8.10, clear
    // 6.34), and light mode improves too. 12% is break-even at 4.50:1, so
    // what this asserts is a CEILING, not a floor. 12px/500 is not large text
    // at any weight below 18.66px bold, so the 3:1 allowance is unavailable.
    const m = gauge.match(
      /backgroundColor: "color-mix\(in oklch, " \+ stroke \+ " (\d+)%, transparent\)"/,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(12);
  });
});
