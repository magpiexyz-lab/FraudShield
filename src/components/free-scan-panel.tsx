"use client";

/**
 * The anonymous free-scan panel. The landing page live demo, replacing a
 * canned animation of a scan that converted at 1.1%.
 *
 * A visitor drops an image, POSTs it to /api/free-scan, and gets a real
 * verdict: the score, the band, and two of the forensic signals. The rest are
 * teased behind signup, which is the whole point of the surface.
 *
 * THREE THINGS IN HERE ARE DELIBERATE REFUSALS TO REUSE CODE, and each one
 * has a reason worth more than the duplication it costs:
 *
 *  1. The signal rows are rendered locally rather than by the paid result
 *     surface component. That one prints a signal weight as a "+N" chip and
 *     the signal id verbatim. On a 2-of-N teaser both are leaks: a page
 *     showing "87" beside "+5" and "+8" lets anyone read the withheld 74
 *     points straight off the screen, and an AI finding would render as raw
 *     vision_arithmetic_mismatch. Only label, severity and detail reach a
 *     reader here -- and since 2026-11-05 only those three plus the id-as-key
 *     reach the BROWSER at all: the route projects the shown signals and no
 *     longer sends `weight`, so the payload and this component finally make
 *     the same promise.
 *
 *  2. The scanning choreography is local rather than imported from the
 *     dashboard upload zone, where the equivalent is module private. Reaching
 *     into that module would pull its whole import graph -- including a type
 *     import from the authenticated scan route -- into the LANDING PAGE
 *     bundle, which is the cold paid-ad entry point and the one bundle in the
 *     product whose size is paid for per click.
 *
 *  3. The teaser is a COUNT, never arithmetic. Same sentence shape the paid
 *     paywall uses: "6 forensic signals found on this document -- 2 shown".
 *     No weighted-sum language appears anywhere in this file.
 *
 * WHAT IS REUSED, ON PURPOSE: ScoreGauge, because its verdict words
 * (Authentic / Needs review / Likely forged) are the only band labels anyone
 * has seen attached to a real score, and a second vocabulary here would make
 * the free verdict and the paid one disagree about the same document. The
 * severity scale, the privacy disclosure and the limited-analysis copy come
 * from their shared modules for the same reason.
 *
 * DESIGN NOTE. The landing page forces a dark subtree and its sections
 * hand-roll raw oklch surfaces, so semantic tokens looked like a mismatch
 * risk. They are not: in globals.css the dark --card is literally
 * oklch(0.218 0.024 252), the same value the neighbouring section hand-rolls
 * for its raised panel, and --border is oklch(0.92 0.02 220 / 12%) against
 * its .../14%. So this file uses tokens throughout and sits flush with its
 * neighbours, with one exception -- the recessed upload well, which wants a
 * surface DARKER than the page ground and has no token for it.
 */

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { ScoreGauge } from "@/app/scan-result/score-gauge";
import { SEVERITY_LABEL, SEVERITY_VAR } from "@/app/scan-result/severity";
import {
  AI_PRIVACY_DISCLOSURE,
  LIMITED_ANALYSIS_BODY,
  LIMITED_ANALYSIS_TITLE,
  NO_INDICATORS_BODY,
  NO_INDICATORS_TITLE,
} from "@/lib/fraud/analysis-mode";
// lib/scan-limits, NOT lib/scan-intake. Same four constants -- scan-intake
// re-exports them -- but scan-intake does a top-level `import exifr`, and this
// component ships in the LANDING PAGE bundle, the cold paid-ad entry point.
// Webpack drops the unused exports either way; it only drops that exifr import
// if the package declares `sideEffects: false`, which could not be verified.
// scan-limits has no imports at all, which is enforced by
// tests/scan-limits.test.ts. Do not "consolidate" this back.
import { ANON_ACCEPTED_MIME, MAX_ANON_BYTES } from "@/lib/scan-limits";
import {
  trackCtaClick,
  trackFreeScanCapped,
  trackFreeScanComplete,
  trackFreeScanStart,
  trackPaywallShown,
} from "@/lib/events";
import type { FraudSignal } from "@/lib/types";
import type { FreeScanCapCode } from "@/lib/free-scan-cap";

// ---------------------------------------------------------------------------
// Wire shapes. Mirrors the route response (src/app/api/free-scan/route.ts).
// ---------------------------------------------------------------------------

/**
 * One shown signal as the route sends it.
 *
 * Four fields, which are exactly the four SignalRow reads: label, severity and
 * detail are rendered, and `id` is the React key and is never displayed. No
 * `weight` -- see the `signals` member below.
 */
type TeaserSignal = Pick<FraudSignal, "id" | "label" | "severity" | "detail">;

type FreeScanOk = {
  score: number;
  severity: FraudSignal["severity"];
  /**
   * The VisionStatus union from lib/fraud/vision.ts, typed as the wire string
   * it arrives as: "analyzed" / "inconclusive" / "unavailable". Read ONLY
   * through isPartialVerdict below -- see the warning there.
   *
   * DELIBERATELY STILL `string`, NOT THE UNION, even though the route now
   * exports it as VisionStatus. Three reasons, and they all point the same
   * way:
   *
   *  1. This is a FETCH BOUNDARY. The value comes from response.json() and
   *     reaches this type through an unchecked `as FreeScanOk` cast. Nothing
   *     validates it. Declaring the union here would assert a guarantee no
   *     code makes - a stale deploy, a proxy error page, or a fourth status
   *     added to vision.ts tomorrow all arrive as something else.
   *  2. isPartialVerdict TREATS AN UNRECOGNISED VALUE AS PARTIAL, which is
   *     the safe direction and the one thing protecting a visitor from a
   *     confident verdict resting on content nothing read. Narrowing this
   *     field would make that branch look unreachable and invite its
   *     deletion - losing the guard to the type that was supposed to help.
   *  3. It would mean a type import from lib/fraud/vision into a client
   *     component in the LANDING PAGE bundle. Erased at build, yes, but it
   *     is the exact dependency direction lib/scan-limits.ts was just
   *     created to avoid, and precedent in this file travels.
   *
   * The compile-error benefit the narrowing exists for lands on the ROUTE,
   * which constructs the value from vision.status and has real type
   * information. Nothing is lost here: the predicate below compares against
   * "analyzed" and is tested directly.
   */
  vision_status: string;
  /**
   * Exactly the teaser subset. Never the full set.
   *
   * `TeaserSignal`, NOT FraudSignal: the route projects each shown signal to
   * four fields and the wire carries no `weight`. Typing it as FraudSignal
   * here would assert a field that is no longer sent -- and it was the type
   * that made it easy to miss that the payload was handing an
   * unauthenticated caller the very weights point 1 of this file's docstring
   * says must never reach a reader.
   */
  signals: TeaserSignal[];
  /** The FULL count. The teaser sentence is meaningless without it. */
  total_signal_count: number;
};

type FreeScanRefusal = {
  code: string;
  /**
   * Server copy, written for a stranger who has not signed up. RENDERED
   * VERBATIM. Every refusal from that route already names the next thing the
   * visitor can do, and paraphrasing it here is how the signup-framed PDF
   * refusal quietly turns back into a dead end.
   */
  message: string;
  resetAt?: number | null;
};

// ---------------------------------------------------------------------------
// Pure helpers. Exported because vitest runs environment "node" with no jsdom
// (see tests/free-scan-panel.test.ts): logic left inline in a client
// component here is logic that cannot be tested at all.
// ---------------------------------------------------------------------------

/** Which cap tripped, in the vocabulary trackFreeScanCapped speaks. */
export type CapKind = "ip" | "site" | "unavailable";

/**
 * Refusal code to cap kind.
 *
 * Typed against FreeScanCapCode minus "ok", so adding a fourth cap code in
 * lib/free-scan-cap.ts is a compile error here rather than a silently
 * unreported cap. WHICH cap tripped is the entire diagnostic value of the
 * event: "ip" is one visitor spending their own three, "site" is the budget
 * for the day gone, "unavailable" is a limiter refusing everybody.
 */
export const CAP_CODE_TO_KIND: Record<
  Exclude<FreeScanCapCode, "ok">,
  CapKind
> = {
  ip_capped: "ip",
  site_capped: "site",
  cap_unavailable: "unavailable",
};

/**
 * The cap kind for a refusal code, or null when the refusal is not a cap.
 *
 * Returns null for too_many_requests on purpose. That 429 prices REQUESTS to
 * bound decode CPU and is not part of the scan allowance (route step 5), so
 * counting it as a cap would make "the free scans for today ran out"
 * unreadable in the funnel.
 *
 * hasOwnProperty rather than the `in` operator: `in` walks the prototype
 * chain, so a code of "constructor" or "toString" would test true and return
 * undefined through a signature that promises CapKind or null.
 */
export function capKindForCode(code: string): CapKind | null {
  return Object.prototype.hasOwnProperty.call(CAP_CODE_TO_KIND, code)
    ? CAP_CODE_TO_KIND[code as Exclude<FreeScanCapCode, "ok">]
    : null;
}

/**
 * Whether a 200 response is a metadata-only verdict rather than a delivered
 * scan.
 *
 * THE PREDICATE IS A COMPARISON AGAINST "analyzed". The plan for this panel
 * specified a comparison against "ok", and "ok" IS NOT A MEMBER of the
 * VisionStatus union ("analyzed" / "inconclusive" / "unavailable"). That
 * comparison is therefore true for every scan ever run, including a fully
 * analyzed one, and the panel would have stamped "Partial analysis" on every
 * success -- undercutting the one claim this surface exists to make.
 *
 * Unknown values fall to true, which is the safe direction: an image whose
 * content was never read scores on EXIF alone, and metadata-only scoring
 * caught 0 of 20 forged PDFs in the accuracy gate. A verdict resting on that
 * must never present as a finished one.
 */
export function isPartialVerdict(visionStatus: string): boolean {
  return visionStatus !== "analyzed";
}

/**
 * The paywall sentence. A COUNT, in the same shape the paid result surface
 * uses, carrying no weights and no sums -- there is nothing here to subtract.
 */
export function teaserHeadline(total: number, shown: number): string {
  const noun = total === 1 ? "signal" : "signals";
  return `${total} forensic ${noun} found on this document \u2014 ${shown} shown`;
}

/** Pre-upload copy. Carries the words an e2e check looks for on a bare page. */
export const IDLE_PROMISE =
  "You get back a real fraud score out of 100, the band it falls in, and the first two forensic signals found on the document.";

/**
 * Client-side refusals, worded to agree with the route.
 *
 * The server stays the authoritative gate -- these only save a visitor a
 * round trip and a wasted request against the per-IP request counter. The
 * ORDER of the checks below mirrors the route (PDF, then type, then empty,
 * then size) so the same file gets the same code and the same framing on both
 * sides.
 */
const LOCAL_REFUSALS = {
  pdf_not_supported:
    "PDF scanning comes with a free account \u2014 the instant scan here takes JPEG, PNG and WebP images. Sign up to scan this PDF.",
  unsupported_type:
    "That file type is not supported here. Upload a JPEG, PNG or WebP image of the document.",
  empty_file: "That file is empty. Please choose another image.",
  file_too_large:
    "That image is over 4 MB. Create a free account for larger uploads, or try a smaller image.",
} as const;

/**
 * The refusals whose own copy offers an account, so the furniture around
 * them has to match the words.
 *
 * Every one of these server messages ends by naming signup as the way
 * forward: PDFs are a paid format, a file over 4 MB needs an account, the
 * request brake suggests an account instead of waiting, and a missing API key
 * promises a scan once it is back. Showing a bare "try another image" button
 * under copy that just offered an account is the kind of small contradiction
 * that reads as a broken page.
 *
 * Caps are NOT listed: capKindForCode already identifies those, and this set
 * would then have two sources of truth for the same question.
 */
const SIGNUP_FRAMED_CODES: ReadonlySet<string> = new Set([
  "pdf_not_supported",
  "file_too_large",
  "too_many_requests",
  "not_configured",
]);

/** Shown when the request never reached the server at all. */
const NETWORK_REFUSAL =
  "The scan request did not reach us. Check your connection and try again.";

/** Shown when a non-2xx response carried no readable body. */
const OPAQUE_REFUSAL =
  "The scan could not be completed. Try again, or create a free account and scan from your dashboard.";

/**
 * Mirror of the route gates, in the route order.
 *
 * A BLANK MIME TYPE IS REFUSED, matching the free route and diverging from
 * the authenticated one. A blank-type PDF treated as an image fails EXIF
 * extraction into a missing-metadata signal and hands back a confident
 * verdict on a document nothing ever looked at.
 *
 * Both limits come from lib/scan-intake. Retyping either number is how one
 * surface starts accepting what the other rejects.
 */
export function rejectFileLocally(
  file: Pick<File, "type" | "size">,
): { code: keyof typeof LOCAL_REFUSALS; message: string } | null {
  const refuse = (code: keyof typeof LOCAL_REFUSALS) => ({
    code,
    message: LOCAL_REFUSALS[code],
  });

  if (file.type === "application/pdf") return refuse("pdf_not_supported");
  if (!file.type || !ANON_ACCEPTED_MIME.has(file.type)) {
    return refuse("unsupported_type");
  }
  if (file.size === 0) return refuse("empty_file");
  if (file.size > MAX_ANON_BYTES) return refuse("file_too_large");
  return null;
}

/** The accept attribute, derived rather than retyped. */
const ACCEPT_ATTR = [...ANON_ACCEPTED_MIME].join(",");

/**
 * What the pipeline is actually doing while the request is open, in the order
 * lib/fraud runs it. These are the real checks named in CHECKS_PERFORMED for
 * an image, not invented reassurance: the motion is a progress readout, so it
 * has to be true.
 */
const SCAN_STAGES = [
  "Reading EXIF metadata",
  "Checking editing-software traces",
  "AI review of the document content",
  "Scoring",
] as const;

/** How many withheld rows get a ruled stub before the shape stops helping. */
const MAX_STUBS = 4;

/** Matches the prefers-reduced-motion hook the landing page already uses. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

type PanelState =
  | { kind: "idle" }
  | { kind: "scanning"; fileName: string }
  | { kind: "result"; data: FreeScanOk }
  | { kind: "refused"; refusal: FreeScanRefusal };

/**
 * One frame that transforms through four states rather than four stacked
 * cards. It takes its reserved height the moment a file is picked rather than
 * the moment a verdict lands, so the page does not shift underneath the
 * visitor as the result appears -- on a paid entry point that moment is the
 * whole conversion. The reservation note on the content area below carries
 * the measurements behind the number.
 *
 * @param variant - the landing page messaging slug, carried on every event so
 *   a variant can be read against its own scan completions. Defaults to
 *   "default" because the panel is also usable outside a variant test.
 */
export function FreeScanPanel({
  variant = "default",
  className,
}: {
  variant?: string;
  className?: string;
}) {
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [stage, setStage] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduced = usePrefersReducedMotion();
  // Generated rather than hardcoded: the panel is a component, and two of
  // them on one page would otherwise share an id.
  const titleId = useId();

  const scanning = state.kind === "scanning";

  // Advances the stage readout while a request is open. Honest pacing: the
  // content pass budgets up to 25s, so the labels walk forward and the last
  // one stays until the response arrives rather than looping back to the
  // start and implying the work restarted.
  useEffect(() => {
    if (!scanning) {
      setStage(0);
      return;
    }
    const id = window.setInterval(() => {
      setStage((s) => Math.min(s + 1, SCAN_STAGES.length - 1));
    }, 1600);
    return () => window.clearInterval(id);
  }, [scanning]);

  async function submit(file: File) {
    // Client gate first. A file refused here never left the machine, so no
    // event fires for it: free_scan_start counts scan ATTEMPTS and the
    // completion rate measured against it would otherwise be reporting
    // file-picker mistakes.
    const local = rejectFileLocally(file);
    if (local) {
      setState({ kind: "refused", refusal: local });
      return;
    }

    // ON SUBMIT, and specifically here: after the local gate, before the
    // request. Not on view (that is visit_landing) and not on file select --
    // choosing a file and never scanning is not an attempt.
    trackFreeScanStart({ variant });
    setState({ kind: "scanning", fileName: file.name });

    const body = new FormData();
    body.append("file", file);

    let response: Response;
    try {
      response = await fetch("/api/free-scan", { method: "POST", body });
    } catch {
      setState({
        kind: "refused",
        refusal: { code: "network_error", message: NETWORK_REFUSAL },
      });
      return;
    }

    const payload = (await response
      .json()
      .catch(() => ({}))) as Partial<FreeScanOk> & Partial<FreeScanRefusal>;

    if (!response.ok) {
      const code = typeof payload.code === "string" ? payload.code : "unknown";
      const message =
        typeof payload.message === "string" ? payload.message : OPAQUE_REFUSAL;
      // Capped scans get their own event so the daily budget is readable
      // separately from refusals a visitor caused.
      const cap = capKindForCode(code);
      if (cap) trackFreeScanCapped({ variant, cap });
      setState({ kind: "refused", refusal: { code, message } });
      return;
    }

    const data = payload as FreeScanOk;

    // ONLY a delivered verdict completes. A metadata-only result renders
    // below as a partial, and counting it here would report the free tier as
    // delivering scans it did not deliver.
    if (!isPartialVerdict(data.vision_status)) {
      // NO TOKEN COUNTS. They used to be read off `data.usage` and sent with
      // this event, which meant the route shipped its billing telemetry and
      // the model name to an unauthenticated caller to get them here. The
      // route logs them server-side now (step 12) and EVENTS.yaml no longer
      // declares them. h-12 is free_scan_complete / free_scan_start and never
      // read them.
      trackFreeScanComplete({
        variant,
        band: data.severity,
        signal_count: data.total_signal_count,
      });
    }

    setState({ kind: "result", data });
  }

  // Not memoized. It closes over submit, which closes over state setters and
  // a prop, so a useCallback here would need a dependency list that lies or a
  // suppression comment -- and nothing below it is a memoized child that
  // would benefit.
  function onPick(files: FileList | null) {
    const file = files?.[0];
    if (file) void submit(file);
  }

  function reset() {
    setState({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  const refusal = state.kind === "refused" ? state.refusal : null;
  const capKind = refusal ? capKindForCode(refusal.code) : null;
  // Every cap points at signup, plus the refusals whose server copy does.
  const signupFramed =
    capKind !== null ||
    (refusal !== null && SIGNUP_FRAMED_CODES.has(refusal.code));

  const stateWord =
    state.kind === "scanning"
      ? "Analyzing"
      : state.kind === "result"
        ? "Verdict"
        : state.kind === "refused"
          ? "Not scanned"
          : "Free scan";

  const progress = scanning
    ? `${SCAN_STAGES[stage]} \u2014 ${state.fileName}`
    : state.kind === "result"
      ? `Verdict ready — fraud score ${state.data.score} out of 100`
      : "";

  return (
    <section
      // NAMED BY A CONSTANT, NOT BY THE STATE RAIL. aria-labelledby used to
      // point at the h3 below, whose text cycles Free scan -> Analyzing ->
      // Verdict -> Not scanned, so landmark and heading navigation announced
      // this region as a transient state word with nothing to attach it to.
      // aria-labelledby is resolved BEFORE aria-label in the accessible-name
      // computation, so it had to be removed rather than merely overridden.
      // The h3 keeps its id and stays the instrument readout it was written
      // to be.
      aria-label="Free document scan"
      className={`relative overflow-hidden rounded-[var(--radius-lg)] bg-card ring-1 ring-border ${className ?? ""}`}
    >
      {/* State rail. The one mono label in the panel, and it earns its place:
          it is an instrument readout that changes, not an eyebrow over a
          heading. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border px-5 py-3.5 sm:px-6">
        <h3
          id={titleId}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-signal"
        >
          {stateWord}
        </h3>
        {/* NOT "3 free scans, no account". The section eyebrow directly
            above this panel already reads "Three free scans a day, images
            only, no account" -- so that slot was the same sentence twice
            inside 580px, set in two type treatments, which reads as anxiety
            rather than emphasis. The eyebrow keeps the offer, because it is
            the line that has to be read BEFORE a visitor commits a document.

            This slot now carries the instrument's spec, which nothing else
            on screen states and which is the claim the free scan is actually
            making at the point of action: it names the two passes SCAN_STAGES
            walks through. The eyebrow says what it costs; the rail says what
            it does. */}
        <p className="font-mono text-[11px] text-muted-foreground">
          Metadata and AI content pass
        </p>
      </div>

      {/* THE FRAME TAKES ITS HEIGHT AT THE PICK, NOT AT THE VERDICT, and
          38rem is a measured number rather than a round one.

          WHAT STOOD HERE BEFORE claimed a constant floor so that "the
          verdict replaces the drop well in place instead of pushing the
          rest of the page down". That floor was 24rem = 384px, which is
          BELOW the idle well itself -- 449px of frame at 412px wide, 510px
          at 360px -- so it reserved nothing. The frame SHRANK 65px when the
          scan started and then grew 599px past idle when the verdict
          arrived. MEASURED at 412x823 with this panel at the top of the
          viewport, that pair of shifts scored 0.2537 CLS: a breach of the
          0.1 budget, on the one surface a paid click lands on.

          Chrome discards a layout shift that falls within 500ms of a real
          pointer or key event. A verdict arrives seconds after the file is
          picked, so its shift can never be discarded -- but the scanning
          state begins on the pick itself, inside that window. So the
          reservation starts at the pick and is held through whatever comes
          back, and the verdict then renders into space already taken.

          38rem = 608px, and it is small on purpose. It is the smallest
          reservation that clears the tallest idle well at any width (510px
          at 360px), so the frame can never SHRINK when a scan starts --
          that shrink was pure loss, a shift with no content to show for it.
          MEASURED content-box heights at 412px wide: refusal 353, clean
          verdict 408, one signal 732, two signals 936. The two-signal
          verdict -- dial, count sentence, two rows, the withheld stubs and
          the teaser, which is the shape this surface exists to produce --
          still grows past the reservation, and that residual measures
          0.0506 at 412x823 and 0.0257 at 1280x900: half the budget, with
          the shrink gone and the refusal and clean-verdict paths at zero.

          A BIGGER NUMBER WAS MEASURED AND REJECTED. 46rem holds nearly all
          of the two-signal verdict and takes the residual to 0.0146, but it
          leaves 335px of empty frame under a refusal and 280px under a
          clean verdict, which are the two most common things this panel
          says. It also buys nothing once the visitor lingers in the file
          dialog: past 500ms the pick-time growth counts too, and the total
          then measures 0.109 at 38rem against 0.1135 at 46rem. So take the
          least frame that is safe.

          NOT APPLIED AT IDLE. A floor tall enough to hold a verdict would
          turn the drop target into an empty slab on arrival. */}
      <div
        className={`px-5 py-6 sm:px-6 sm:py-7${
          state.kind === "idle" ? "" : " min-h-[38rem]"
        }`}
      >
        {state.kind === "idle" ? (
          <div className="flex flex-col gap-5">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                onPick(e.dataTransfer.files);
              }}
              className="flex flex-col items-center gap-4 rounded-[var(--radius-md)] border border-dashed px-5 py-9 text-center transition-colors duration-150"
              style={{
                // Recessed: darker than the page ground, so the target reads
                // as a slot you put something into rather than another card
                // sitting on top of the section.
                background: "oklch(0.16 0.02 252)",
                // WCAG 1.4.11 (3:1) ON THE RESTING EDGE. The well itself is
                // only 1.12:1 against the card -- deliberately, that IS the
                // recess -- so the dashed edge is the only thing that says
                // where the target begins, and at 22% alpha it measured
                // 1.77:1 against the well. 42% measures 3.47:1 against the
                // well and 3.11:1 against the card, clearing the threshold
                // on both sides of the edge while leaving the fill dark. Do
                // not lower it to recover the softer look: the recess lives
                // in the BACKGROUND above, not in the border.
                borderColor: dragging
                  ? "var(--signal)"
                  : "oklch(0.92 0.02 220 / 42%)",
              }}
            >
              <DocumentGlyph />
              <div className="space-y-1.5">
                <p className="font-heading text-[19px] font-bold leading-tight tracking-[-0.3px] text-foreground">
                  Drop an image of the document
                </p>
                <p className="font-sans text-[13px] text-muted-foreground">
                  Pay stub, bank statement or invoice. Up to 4 MB.
                </p>
              </div>
              {/* py-3, NOT py-2.5, ON ALL THREE FILLED CTAs IN THIS FILE.
                  MEASURED at a 390px viewport: py-2.5 gave this button a
                  40px box (10 + 20 line-box + 10), under the 44px minimum
                  touch target -- on the one control the paid-ad click in
                  this experiment exists to reach, and the only control in
                  the idle panel at all. py-3 lands it at exactly 44. The two
                  account links carry the same padding for the same reason:
                  they are the mobile exits from a refusal and from a
                  verdict, where a missed tap is the whole funnel. */}
              {/* THE OFFSET GROUND BELOW IS THE WELL, NOT THE CARD, AND THAT
                  IS NOT A DIVERGENCE FROM ITS TWO SIBLINGS.
                  Raised 2026-11-06 as the focus-ring pass having left one of
                  three filled CTAs offsetting against the wrong ground, on
                  the premise that all three sit on the card. They do not.
                  This one is a child of the recessed well a few lines up,
                  whose fill is set inline to oklch(0.16 0.02 252), and the
                  nearest painted ancestor of this element resolves to exactly
                  that -- CHECKED in the browser, not read off the JSX. The
                  other two filled CTAs, the refusal account link and the
                  teaser account link, are direct children of the content area
                  and do sit on the card, which is why they name it. The well
                  measures only 1.12:1 against the card, so pointing this one
                  at the card would paint its 2px gap in a colour that is not
                  behind it -- which is the defect the report meant to catch,
                  reintroduced. Left as it is; each of the three names the
                  surface it is actually on. */}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-[var(--radius-pill)] bg-signal px-6 py-3 font-sans text-sm font-semibold text-signal-foreground shadow-[var(--shadow-signal-glow)] transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[oklch(0.16_0.02_252)]"
              >
                Select an image
              </button>
              <ul
                aria-label="Accepted image formats"
                className="flex items-center gap-2"
              >
                {["JPG", "PNG", "WEBP"].map((ext) => (
                  <li
                    key={ext}
                    className="rounded-[var(--radius-pill)] px-2.5 py-1 font-mono text-[10px] tracking-wide text-muted-foreground ring-1 ring-border"
                  >
                    {ext}
                  </li>
                ))}
              </ul>
              {/* THE iPHONE LINE, AND WHY IT IS HERE RATHER THAN IN THE CHIPS.
                  ACCEPT_ATTR derives from ANON_ACCEPTED_MIME, which filters
                  ACCEPTED_MIME to image/*, so the file picker OFFERS
                  image/heic -- a format sharp's prebuilt binaries cannot
                  decode at all. A HEIC is therefore always refused
                  (`image_unreadable`), and HEIC is the default iPhone camera
                  format on the likeliest mobile visitor from paid traffic.

                  The gap was closable from either side. Widening the chips to
                  advertise HEIC was REJECTED: a chip is a promise, and
                  promising a format that is guaranteed to fail turns an
                  unadvertised surprise into a broken promise. The chips stay
                  at the three formats that actually work.

                  So the fix is to move the refusal EARLIER -- said before the
                  picker opens rather than after the upload comes back. Same
                  principle the `accept` attribute already applies to PDFs
                  (e2e/behaviors.spec.ts: "the accept attribute is what stops
                  a visitor reaching that refusal at all"); this is that
                  principle for the one format `accept` cannot exclude from
                  here, because ANON_ACCEPTED_MIME is derived in
                  lib/scan-limits.ts.

                  Muted and secondary: it must not outrank the CTA above it.

                  CUT TO ONE LINE 2026-11-05. The well already carries a
                  glyph, a headline, a constraint line, the CTA and the format
                  chips; at 46ch this warning wrapped to two lines and made a
                  sixth block, bottom-weighting the one target on the page a
                  visitor is meant to act in. "which cannot be read here" was
                  also doing a job the chips directly above already do by
                  omission. What survives is the half that is actionable. */}
              <p className="max-w-[54ch] font-sans text-[12px] leading-[1.45] text-muted-foreground">
                iPhone photos are HEIC — export one as JPEG first.
              </p>
            </div>
            <p className="max-w-[62ch] font-sans text-[15px] leading-[1.55] text-[oklch(0.82_0.012_244)]">
              {IDLE_PROMISE}
            </p>
          </div>
        ) : null}

        {state.kind === "scanning" ? (
          <ScanningFrame
            fileName={state.fileName}
            label={SCAN_STAGES[stage]}
            reduced={reduced}
          />
        ) : null}

        {state.kind === "result" ? (
          <ResultView data={state.data} onReset={reset} variant={variant} />
        ) : null}

        {refusal ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <RefusalGlyph signup={signupFramed} />
            <p className="font-heading text-[19px] font-bold leading-tight tracking-[-0.3px] text-foreground">
              {signupFramed
                ? "Scan this document with a free account"
                : "That file was not scanned"}
            </p>
          </div>
        ) : null}

        {/* WCAG 4.1.3: ALWAYS MOUNTED, visibility toggled by class. A live
            region that mounts at the same moment its content appears is not
            announced at all. This paragraph is also the only place the server
            copy is printed, so a refusal is never read out twice.

            Styled with the destructive token rather than a severity colour:
            a rejected upload is a system outcome, not a forged-document
            finding, and the two must not look alike on a page whose whole
            subject is forged documents. */}
        <p
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
          className={
            refusal
              ? "mx-auto max-w-[62ch] rounded-[var(--radius-md)] bg-destructive/10 px-4 py-3 text-center font-sans text-[14px] leading-[1.55] text-foreground ring-1 ring-destructive/25"
              : "sr-only"
          }
        >
          {refusal?.message ?? ""}
        </p>

        {refusal ? (
          <div className="mt-5 flex flex-col items-center gap-3">
            {signupFramed ? (
              <Link
                href="/signup"
                // A REAL LANDING-PAGE EXIT, so it counts as one. This link
                // fired nothing before, which understated h-01
                // (cta_click / visit_landing) for the whole panel: the
                // visitor sat in the reach denominator and was missing from
                // the demand numerator. Same wrapper and same `variant`
                // property the four landing CTAs send, so the five read
                // together.
                onClick={() => trackCtaClick({ variant })}
                className="rounded-[var(--radius-pill)] bg-signal px-6 py-3 font-sans text-sm font-semibold text-signal-foreground shadow-[var(--shadow-signal-glow)] transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                Create a free account
              </Link>
            ) : null}
            <button
              type="button"
              onClick={reset}
              className="py-1.5 font-sans text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
            >
              Try another image
            </button>
          </div>
        ) : null}

        {/* Fires paywall_shown once, and only for a real cap. A 415 or a 413
            is not a paywall, and counting it as one would pad the denominator
            that checkout_start is measured against. */}
        {capKind ? <PaywallBeacon /> : null}

        {/* WCAG 4.1.3: always mounted, permanently sr-only. The stage label
            and the verdict are both on screen already; this exists so the
            same information reaches a screen reader as it changes. Polite,
            never assertive -- routine progress must not interrupt. */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {progress}
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={(e) => onPick(e.target.files)}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
      />

      {/* Disclosure stays on screen in EVERY state, as the dashboard does.
          vision.ts makes it a pre-upload requirement: the document is sent to
          a third party for the content pass, and the visitor has to know that
          before the file leaves the machine, not after. */}
      <p className="border-t border-border px-5 py-3.5 font-sans text-[12px] leading-[1.5] text-muted-foreground sm:px-6">
        {AI_PRIVACY_DISCLOSURE}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Glyphs. Hand-drawn rather than pulled from an icon package: this component
// renders on the cold paid-ad entry point, and two shapes are not worth a
// dependency in that bundle.
// ---------------------------------------------------------------------------

function DocumentGlyph() {
  return (
    <svg
      width="34"
      height="40"
      viewBox="0 0 34 40"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 3.5h17.5L31 13v23.5H3z"
        stroke="oklch(0.92 0.02 220 / 34%)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M20.5 3.5V13H31"
        stroke="oklch(0.92 0.02 220 / 34%)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 20h16M9 25.5h11"
        stroke="oklch(0.92 0.02 220 / 22%)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      {/* The one cyan mark: the line a scan would read. */}
      <path
        d="M9 31h8"
        stroke="var(--signal)"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function RefusalGlyph({ signup }: { signup: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-11 items-center justify-center rounded-full ring-1"
      style={{
        background: signup
          ? "color-mix(in oklch, var(--signal) 12%, transparent)"
          : "color-mix(in oklch, var(--destructive) 12%, transparent)",
        color: signup ? "var(--signal)" : "var(--destructive)",
        boxShadow: signup
          ? "inset 0 0 0 1px color-mix(in oklch, var(--signal) 28%, transparent)"
          : "inset 0 0 0 1px color-mix(in oklch, var(--destructive) 28%, transparent)",
      }}
    >
      {signup ? (
        // A closed padlock: the scan is available, behind an account.
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <rect
            x="3.2"
            y="7.8"
            width="11.6"
            height="7.4"
            rx="1.6"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M6 7.8V5.6a3 3 0 0 1 6 0v2.2"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
          <circle cx="9" cy="9" r="6.4" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M9 5.6v4.6"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="9" cy="12.6" r="0.9" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}

/**
 * Fires paywall_shown exactly once per mount and renders nothing.
 *
 * The fire-once ref is the pattern the paid paywall uses: the metric is
 * checkout_start over paywall_shown, and a per-render emit would destroy the
 * denominator the event exists to supply.
 */
function PaywallBeacon() {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    trackPaywallShown({ surface: "free_scan_cap" });
  }, []);
  return null;
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * The one orchestrated motion in the panel: a single cyan beam crossing a
 * document silhouette while the request is open, with the check that is
 * running named beneath it in mono.
 *
 * Written locally rather than imported from the dashboard, for the bundle
 * reason in this file header. The choreography matches it so the free scan
 * and the paid one look like the same instrument.
 *
 * Reduced motion parks the beam mid-document at low opacity: the frame still
 * reads as "in progress" without anything moving, and the stage label below
 * carries the actual progress.
 */
function ScanningFrame({
  fileName,
  label,
  reduced,
}: {
  fileName: string;
  label: string;
  reduced: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-5 py-6">
      <div
        aria-hidden="true"
        className="relative h-36 w-56 overflow-hidden rounded-[var(--radius-md)] ring-1 ring-border"
        style={{ background: "oklch(0.16 0.02 252)" }}
      >
        <div className="absolute inset-x-5 top-5 space-y-2">
          <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/25" />
          <div className="h-1.5 w-1/2 rounded-full bg-muted-foreground/20" />
          <div className="h-1.5 w-2/3 rounded-full bg-muted-foreground/20" />
          <div className="h-1.5 w-2/5 rounded-full bg-muted-foreground/15" />
          <div className="h-1.5 w-1/3 rounded-full bg-muted-foreground/15" />
        </div>
        <div className={reduced ? "beam beam-parked" : "beam"}>
          <div className="beam-line" />
        </div>
      </div>

      <div className="space-y-1.5 text-center">
        <p className="font-mono text-[13px] text-signal">{label}</p>
        <p className="max-w-[32ch] truncate font-mono text-[11px] text-muted-foreground">
          {fileName}
        </p>
      </div>

      <style jsx>{`
        .beam {
          position: absolute;
          left: 0;
          right: 0;
          height: 3.5rem;
          background: linear-gradient(
            to bottom,
            transparent,
            color-mix(in oklch, var(--signal) 26%, transparent) 50%,
            transparent
          );
          animation: free-scan-sweep 1.9s cubic-bezier(0.22, 1, 0.36, 1)
            infinite;
        }
        .beam-line {
          position: absolute;
          left: 0;
          right: 0;
          top: 50%;
          height: 1px;
          background: oklch(0.86 0.14 210);
          box-shadow: 0 0 12px 2px
            color-mix(in oklch, var(--signal) 55%, transparent);
        }
        @keyframes free-scan-sweep {
          0% {
            top: -3.5rem;
            opacity: 0;
          }
          12% {
            opacity: 1;
          }
          88% {
            opacity: 1;
          }
          100% {
            top: 9rem;
            opacity: 0;
          }
        }
        .beam-parked {
          animation: none;
          top: 2.75rem;
          opacity: 0.45;
        }
        /* Duplicates the parked state the reduced prop produces. NOT
           redundant: the prop is false on the server and on the first client
           paint, so without this rule a visitor who asked for no motion sees
           one frame of a sweeping beam before the effect resolves. */
        @media (prefers-reduced-motion: reduce) {
          .beam {
            animation: none;
            top: 2.75rem;
            opacity: 0.45;
          }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function ResultView({
  data,
  onReset,
  variant,
}: {
  data: FreeScanOk;
  onReset: () => void;
  /**
   * Threaded down purely so the teaser CTA can attribute its cta_click. An
   * unattributed click cannot be read against the variant that produced it,
   * which is the whole reason this surface is instrumented per variant.
   */
  variant: string;
}) {
  const partial = isPartialVerdict(data.vision_status);
  const shown = data.signals.length;
  // Clamped against the shown count so a stale or malformed total can never
  // print a negative withheld count.
  const total = Math.max(data.total_signal_count, shown);
  const withheld = total - shown;

  return (
    // MASTHEAD OVER EVIDENCE, AND THE BREAKPOINT IS THE PANEL'S OWN WIDTH.
    //
    // This was `lg:flex-row` -- a VIEWPORT query on a component whose width
    // is set by the landing grid, not by the window. Measured on the live
    // page, that column is 576px wide, so at every desktop size the branch
    // fired and produced: a 240px dial pinned top-left, 256px of gutter
    // beside it for ALL the evidence, and roughly 500px of dead space under
    // the dial where the rows ran past it. Every signal label wrapped to two
    // lines, every detail to three, and the severity word sat beside the
    // first line of a wrapping label looking unattached. The verdict did not
    // resolve; it ran down a trench.
    //
    // A container query asks the right question. `@lg` is 32rem, and the
    // dial plus its gap eat 16.5rem of whatever is left, so the threshold is
    // really "is there 15rem of room beside the dial". MEASURED content-box
    // widths of this panel: 33rem at 1440 (pairs, 16.5rem for the sentence),
    // 42rem at 768 where the landing grid is still one column (pairs), and
    // 28.6rem at exactly 1024 -- the first width where the two-column grid
    // engages and the panel is at its NARROWEST. That one stacks, which is
    // why the threshold is @lg and not @md: @md would have matched 28.6rem
    // and left the sentence 12rem, four lines of rag beside a 15rem dial.
    // The evidence gets the full measure at every width either way.
    //
    // The count sentence moves up here out of the teaser box. It is the one
    // line that belongs beside the number: the dial says how bad, this says
    // how much of the reason you are being shown, the rows show it, the
    // stubs show it being cut off, and the teaser is then just the door.
    // That is a sequence rather than a pile.
    <div className="@container flex flex-col gap-6">
      <div className="flex flex-col items-center gap-3 @lg:flex-row @lg:items-center @lg:gap-6">
        <div className="shrink-0">
          {/* The lock-in. 120ms of delay so the dial and the rows resolve
              together instead of racing each other. */}
          <ScoreGauge score={data.score} startDelayMs={120} />
        </div>
        {shown > 0 ? (
          <p className="max-w-[30ch] text-balance text-center font-heading text-[18px] font-bold leading-snug tracking-[-0.2px] text-foreground @lg:text-left">
            {teaserHeadline(total, shown)}
          </p>
        ) : null}
      </div>

      <div className="min-w-0">
        {partial ? <PartialNotice /> : null}

        {shown === 0 ? (
          <div>
            <p className="font-heading text-[17px] font-bold tracking-[-0.2px] text-foreground">
              {NO_INDICATORS_TITLE}
            </p>
            <p className="mt-1.5 max-w-[58ch] font-sans text-[13px] leading-[1.55] text-muted-foreground">
              {NO_INDICATORS_BODY}
            </p>
          </div>
        ) : (
          // border-t: the list hangs off the masthead above it rather than
          // floating under it. divide-y alone leaves the first row with no
          // top edge, which is what made this read as a second pile.
          <ul className="divide-y divide-border border-t border-border">
            {data.signals.map((sig) => (
              <SignalRow key={sig.id} signal={sig} />
            ))}
            {withheld > 0 ? <WithheldStubs count={withheld} /> : null}
          </ul>
        )}

        {withheld > 0 ? <Teaser variant={variant} /> : null}

        <button
          type="button"
          onClick={onReset}
          className="mt-5 py-1.5 font-sans text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          Scan another image
        </button>
      </div>
    </div>
  );
}

/**
 * Why THIS verdict rests on metadata alone.
 *
 * Exported so the sentence is assertable from a node-environment test, and
 * kept separate from the shared limited-analysis copy because it makes a
 * different claim: the shared body is about what a full scan adds, this is
 * about what did not finish on this one document.
 */
export const PARTIAL_CAUSE =
  "The AI content review did not finish on this document, so this score rests on its metadata alone.";

/**
 * A verdict that rests on metadata alone.
 *
 * Shown whenever the content pass did not return a determination. Carries the
 * shared copy rather than a local paraphrase, because the dashboard says the
 * same thing about the same situation and a second wording is a second claim.
 * Suspect-amber rather than destructive: nothing failed, the analysis is just
 * shallower than a full scan.
 */
function PartialNotice() {
  return (
    <div
      className="mb-5 rounded-[var(--radius-md)] p-4"
      style={{
        background: "color-mix(in oklch, var(--suspect) 10%, transparent)",
        boxShadow:
          "inset 0 0 0 1px color-mix(in oklch, var(--suspect) 26%, transparent)",
      }}
    >
      <p className="font-sans text-[14px] font-semibold text-foreground">
        {LIMITED_ANALYSIS_TITLE}
      </p>
      {/* ONE LOCAL SENTENCE, AND IT SAYS SOMETHING THE SHARED COPY DOES NOT.
          The only thing that raises this notice on the anonymous surface is
          the content pass failing to return a determination -- never the file
          format, because this surface accepts images only. The shared body
          below explains the images-versus-PDF ceiling, which is true of every
          scan here including the fully analysed ones, so on its own it sent a
          visitor whose pass timed out off to find a PDF when the cure is to
          try again. This names the cause; the shared body still owns the
          claim about what a full scan adds, and is not paraphrased here. */}
      <p className="mt-1 max-w-[58ch] font-sans text-[13px] leading-[1.55] text-muted-foreground">
        {PARTIAL_CAUSE}
      </p>
      <p className="mt-1 max-w-[58ch] font-sans text-[13px] leading-[1.55] text-muted-foreground">
        {LIMITED_ANALYSIS_BODY}
      </p>
    </div>
  );
}

/**
 * One forensic finding.
 *
 * Label, severity word, detail. No weight, no id. The severity word is what
 * makes the colour accessible -- the bar alone would encode the finding in
 * colour only.
 */
function SignalRow({ signal }: { signal: TeaserSignal }) {
  const tone = SEVERITY_VAR[signal.severity];
  return (
    <li className="relative py-3.5 pl-4">
      <span
        aria-hidden="true"
        className="absolute bottom-3.5 left-0 top-3.5 w-[2px] rounded-full"
        style={{ background: tone }}
      />
      <div className="flex items-baseline justify-between gap-3">
        <p className="font-sans text-[15px] font-medium leading-snug text-foreground">
          {signal.label}
        </p>
        <span
          className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em]"
          style={{ color: tone }}
        >
          {SEVERITY_LABEL[signal.severity]}
        </span>
      </div>
      <p className="mt-1 max-w-[58ch] font-sans text-[13px] leading-[1.5] text-muted-foreground">
        {signal.detail}
      </p>
    </li>
  );
}

/**
 * THE ONE BOLD THING IN THIS PANEL.
 *
 * The withheld findings keep the geometry of a real row -- same left bar, same
 * two lines -- with the words removed and the opacity falling away. The
 * verdict does not end; it is visibly cut off. That is the paywall as a
 * SHAPE, and it carries no number a reader could work backwards from.
 *
 * Decorative and aria-hidden: the authoritative statement of how many were
 * withheld is the sentence underneath, which is real text.
 *
 * Capped at MAX_STUBS. A twelve-signal document would otherwise produce a
 * wall of grey rules and lose the one thing the device is for.
 */
function WithheldStubs({ count }: { count: number }) {
  const stubs = Math.min(count, MAX_STUBS);
  return (
    <li aria-hidden="true" className="relative space-y-3.5 py-4 pl-4">
      <span
        className="absolute bottom-4 left-0 top-4 w-[2px] rounded-full bg-muted-foreground/20"
      />
      {Array.from({ length: stubs }).map((_, i) => (
        <div key={i} className="space-y-1.5" style={{ opacity: 0.55 - i * 0.12 }}>
          <span className="block h-[9px] w-1/2 rounded-full bg-muted-foreground/30" />
          <span className="block h-[7px] w-3/4 rounded-full bg-muted-foreground/20" />
        </div>
      ))}
    </li>
  );
}

/**
 * The door.
 *
 * THE COUNT SENTENCE IS NO LONGER HERE. teaserHeadline now sets beside the
 * dial in the verdict masthead (see ResultView), because it is the line that
 * reads against the number rather than against the CTA: stating "6 found, 2
 * shown" down here, under the two rows and the cut-off stubs that had already
 * shown the reader exactly that, was the third time the panel made the same
 * point in one column. What is left in this box is the half that only works
 * next to a button -- what an account is actually good for, and the account.
 *
 * Still nothing about points and nothing about how the score was assembled.
 */
function Teaser({
  variant,
}: {
  /** Carried only so the CTA below can attribute its cta_click. */
  variant: string;
}) {
  return (
    <div className="mt-5 rounded-[var(--radius-md)] bg-accent/25 p-4 ring-1 ring-border">
      {/* HONESTY GATE, NOT MARKETING SOFTNESS. This paragraph used to read "A
          free account opens the rest, and takes PDFs as well as images", under
          a CTA labelled "See all N signals". A FREE ACCOUNT DOES NOT OPEN THE
          REST: on the authenticated result surface the per-signal breakdown
          component is rendered only when `isPro`, and every other visitor gets
          LockedSignals instead (see the ternary in scan-result-client.tsx), so
          a visitor who signs up on that promise arrives at a blurred wall and
          a paid upsell. That is the bait-and-switch this teaser exists to
          avoid, moved one click later where it costs the signup it just
          bought. The claims below are the ones a FREE account actually
          keeps.

          "Every finding", not "Each one". With the count sentence moved to
          the verdict masthead this box lost the antecedent "each one" was
          pointing at, and the pronoun quietly re-aimed itself at the grey
          stubs directly above -- which are the findings a reader CANNOT see.
          The subject has to be named here now that the box stands alone. */}
      <p className="max-w-[56ch] font-sans text-[13px] leading-[1.55] text-muted-foreground">
        Every finding names what was detected and where it was found. A free account
        scans PDFs and larger files from your own dashboard; the full
        per-signal breakdown comes with a paid plan.
      </p>
      <Link
        href="/signup"
        // The SECOND real landing-page exit in this panel, and the one a
        // visitor reaches after seeing a withheld count -- the strongest
        // intent signal the free scan produces. It fired nothing before.
        // See the cap-state CTA above for why that understated h-01.
        onClick={() => trackCtaClick({ variant })}
        className="mt-3.5 inline-block rounded-[var(--radius-pill)] bg-signal px-5 py-3 font-sans text-sm font-semibold text-signal-foreground shadow-[var(--shadow-signal-glow)] transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-card"
      >
        {/* NOT "See all {total} signals". Same reason as the paragraph above:
            signup does not reveal them, so the label was a promise the next
            page breaks. This is the same wording the cap-state CTA uses, so
            the panel's one door has one name. */}
        Create a free account
      </Link>
    </div>
  );
}
