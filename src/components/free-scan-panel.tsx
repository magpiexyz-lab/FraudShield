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
 *     reader here.
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
  /** Exactly the teaser subset. Never the full set. */
  signals: FraudSignal[];
  /** The FULL count. The teaser sentence is meaningless without it. */
  total_signal_count: number;
  usage?: { input_tokens?: number; output_tokens?: number; model?: string };
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
    "PDF scanning comes with a free account \u2014 the instant scan here takes JPEG and PNG images. Sign up to scan this PDF.",
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
 * cards. The frame holds a constant minimum height so the page does not shift
 * underneath the visitor at the exact moment the verdict lands -- on a paid
 * entry point that moment is the whole conversion.
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
      trackFreeScanComplete({
        variant,
        band: data.severity,
        signal_count: data.total_signal_count,
        input_tokens: data.usage?.input_tokens,
        output_tokens: data.usage?.output_tokens,
        model: data.usage?.model,
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
      aria-labelledby={titleId}
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
        <p className="font-mono text-[11px] text-muted-foreground">
          3 free scans, no account
        </p>
      </div>

      {/* Constant floor height: the verdict replaces the drop well in place
          instead of pushing the rest of the page down. */}
      <div className="min-h-[24rem] px-5 py-6 sm:px-6 sm:py-7">
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
                borderColor: dragging
                  ? "var(--signal)"
                  : "oklch(0.92 0.02 220 / 22%)",
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
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-[var(--radius-pill)] bg-signal px-6 py-2.5 font-sans text-sm font-semibold text-signal-foreground transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[oklch(0.16_0.02_252)]"
                style={{ boxShadow: "var(--shadow-signal-glow)" }}
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
                className="rounded-[var(--radius-pill)] bg-signal px-6 py-2.5 font-sans text-sm font-semibold text-signal-foreground transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                style={{ boxShadow: "var(--shadow-signal-glow)" }}
              >
                Create a free account
              </Link>
            ) : null}
            <button
              type="button"
              onClick={reset}
              className="font-sans text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      <div className="flex shrink-0 justify-center lg:w-[240px]">
        {/* The lock-in. 120ms of delay so the dial and the rows resolve
            together instead of racing each other. */}
        <ScoreGauge score={data.score} startDelayMs={120} />
      </div>

      <div className="min-w-0 flex-1">
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
          <ul className="divide-y divide-border">
            {data.signals.map((sig) => (
              <SignalRow key={sig.id} signal={sig} />
            ))}
            {withheld > 0 ? <WithheldStubs count={withheld} /> : null}
          </ul>
        )}

        {withheld > 0 ? (
          <Teaser total={total} shown={shown} variant={variant} />
        ) : null}

        <button
          type="button"
          onClick={onReset}
          className="mt-5 font-sans text-sm font-medium text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
        >
          Scan another image
        </button>
      </div>
    </div>
  );
}

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
function SignalRow({ signal }: { signal: FraudSignal }) {
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
 * The paywall sentence and the door.
 *
 * Says how many findings exist and how many were shown. Nothing about points,
 * nothing about how the score was assembled -- the count is the whole offer,
 * and it is the same sentence shape the paid result surface uses so the two
 * paywalls read as one product.
 */
function Teaser({
  total,
  shown,
  variant,
}: {
  total: number;
  shown: number;
  /** Carried only so the CTA below can attribute its cta_click. */
  variant: string;
}) {
  return (
    <div className="mt-5 rounded-[var(--radius-md)] bg-accent/25 p-4 ring-1 ring-border">
      <p className="font-heading text-[16px] font-bold leading-snug tracking-[-0.2px] text-foreground">
        {teaserHeadline(total, shown)}
      </p>
      <p className="mt-1.5 max-w-[56ch] font-sans text-[13px] leading-[1.55] text-muted-foreground">
        Each one names what was detected and where it was found. A free account
        opens the rest, and takes PDFs as well as images.
      </p>
      <Link
        href="/signup"
        // The SECOND real landing-page exit in this panel, and the one a
        // visitor reaches after seeing a withheld count -- the strongest
        // intent signal the free scan produces. It fired nothing before.
        // See the cap-state CTA above for why that understated h-01.
        onClick={() => trackCtaClick({ variant })}
        className="mt-3.5 inline-block rounded-[var(--radius-pill)] bg-signal px-5 py-2.5 font-sans text-sm font-semibold text-signal-foreground transition-[transform,box-shadow] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        style={{ boxShadow: "var(--shadow-signal-glow)" }}
      >
        See all {total} signals
      </Link>
    </div>
  );
}
