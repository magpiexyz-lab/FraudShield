// POST /api/free-scan — the anonymous free scan behind the landing page's
// live demo.
//
// No account, no session, nothing persisted. The visitor uploads an image, we
// run the SAME pipeline the paid route runs (src/lib/fraud/run-scan.ts), and
// return a score with two of the forensic signals. The rest are teased behind
// signup, which is the whole point of the surface.
//
// WHAT MAKES THIS ROUTE DIFFERENT FROM /api/scan: it spends money for a caller
// we cannot identify or bill. One accepted request is one `claude-opus-5`
// vision call. The only things standing between that and an uncapped spend are
// two SCAN counters — 3 per IP per 24h, 30 per day site-wide — so THE ORDER OF
// THE GATES BELOW IS PART OF THE SECURITY MODEL, not a style choice. Each step
// documents what goes wrong if it moves.
//
// A THIRD counter (20 requests per IP per hour) sits above the decode. It is
// not part of the scan allowance: it exists because the decode gate has to run
// ABOVE the scan counters, which left the sharp decode itself free to anyone
// willing to send junk. See step 5.
//
// Deliberately absent:
//   - No Supabase, no `subscriptions` read, no computeQuota/scanWindowStart.
//     An IP cap is not a user quota, and the entitlement machinery exists to
//     answer "what has this ACCOUNT paid for", a question with no answer here.
//   - No analytics. The three `free_scan_*` events fire from the client
//     component that owns the panel; a server-side emit would attribute an
//     anonymous visitor to a server distinct id, and `activate` must never
//     fire for someone who has not signed up. The token counts ARE recorded
//     here, as a `console.info` line at step 12 — a log is not an emit, and
//     it is the only record of what a free scan cost now that those counts no
//     longer ride on the response.
//   - No persistence. There is no migration for anonymous scans and
//     `scans.user_id` is `not null references auth.users`.
//   - Images only, 4 MB — see ANON_ACCEPTED_MIME / MAX_ANON_BYTES in
//     lib/scan-intake.ts. Stricter than the authenticated path on purpose.
//     "Images only" is enforced TWICE, and the second one is the one that
//     counts: step 3 checks the client-supplied Content-Type, step 6 sniffs
//     the real format out of the bytes (ANON_DECODE_FORMATS) and refuses
//     vector, multi-frame and unnamed raster formats before anything is
//     rendered.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { decideFreeScanCap, type FreeScanCapCode } from "@/lib/free-scan-cap";
import { selectTeaserSignals } from "@/lib/free-scan-teaser";
import { runFraudScan } from "@/lib/fraud/run-scan";
import { prepareImage } from "@/lib/fraud/vision";
import { scoreSeverity } from "@/lib/fraud/score";
import {
  ANON_ACCEPTED_MIME,
  ANON_DECODE_FORMATS,
  MAX_ANON_BYTES,
  MAX_ANON_INPUT_PIXELS,
} from "@/lib/scan-intake";
import type { FraudSignal } from "@/lib/types";
import type { RateLimitResult } from "@/lib/rate-limit";
import type { VisionStatus } from "@/lib/fraud/vision";

// sharp (the decode gate) and Buffer are Node APIs — pin the runtime rather
// than relying on the default. maxDuration covers the AI content pass, which
// budgets up to 25s of its own before falling back. Mirrors /api/scan:40-41.
export const runtime = "nodejs";
export const maxDuration = 60;

/** How many of the forensic signals the free scan shows. The rest are teased. */
const TEASER_SIGNAL_COUNT = 2;

/** Per-IP: 3 scans per rolling 24h. */
const IP_MAX = 3;
/**
 * Per-IP: 20 REQUESTS per rolling hour.
 *
 * THIS COUNTER PRICES REQUESTS. `free-scan:ip:` prices COMPLETED SCANS. They
 * are deliberately separate, and the reason is the decode gate at step 6:
 * `prepareImage` has to run ABOVE the scan counters so that an undecodable
 * upload costs no scan allowance — HEIC is the default iPhone camera format
 * and sharp's prebuilt binaries cannot read it, so those uploads are
 * expected traffic, not abuse. That ordering left the sharp decode itself
 * free and unmetered: an attacker could force repeated 4 MB decodes without
 * consuming any counter (security finding `resource-bound-placement`).
 *
 * WHAT BOUNDS ONE DECODE, ACCURATELY. This comment used to claim sharp's
 * `limitInputPixels` bounded each decode, so the defect was "unpriced, not
 * unbounded". THAT WAS FALSE: `prepareImage` set no such limit, and the
 * default (~268 MP) is not a bound anyone chose. Worse, a pixel ceiling would
 * not have helped against the decode found in review — a 0.02 MB SVG of ~300
 * stacked `feGaussianBlur` layers, measured at 229,141 ms against a
 * 60-second lambda, is only ~4 megapixels.
 *
 * What bounds a decode now is step 6: the detected format must be one of
 * ANON_DECODE_FORMATS (so no vector, no multi-frame, no exotic raster reaches
 * the renderer at all) and MAX_ANON_INPUT_PIXELS is passed to sharp
 * explicitly. This counter still prices what is left, because a bounded
 * decode repeated without limit is still free CPU.
 *
 * 20/hour, not 3: the number has to be loose enough that a real visitor who
 * retries a HEIC, exports a JPEG, and then scans a second document never
 * meets it, while still putting a ceiling on how much CPU one address can
 * demand for free.
 */
const REQ_MAX = 20;
const REQ_WINDOW_SEC = 3600;
/** Site-wide: 30 scans per rolling 24h. Manager-approved 2026-10-30. */
const SITE_MAX = 30;
const WINDOW_SEC = 86400;
const GLOBAL_KEY = "free-scan:global";

/**
 * Shape returned to the client on success.
 *
 * `total_signal_count` is the FULL count, not `signals.length`. The panel
 * renders "N forensic signals found on this document — 2 shown", and that
 * sentence is the paywall; equal numbers make it invisible.
 *
 * `vision_status` IS THE UNION, NOT `string`. It is always `vision.status`,
 * and declaring it `string` already caused a real defect: the plan for the
 * panel said to branch on `vision_status !== "ok"`, and "ok" is not a member
 * of VisionStatus ("analyzed" / "inconclusive" / "unavailable"). Against
 * `string` that comparison type-checks and is true for every scan ever run,
 * including a fully analyzed one — the panel would have stamped "Partial
 * analysis" on every success, on the one surface whose job is proving the scan
 * is real. It was caught by reading the type. Against the union, tsc rejects
 * it. (Note "ok" IS a legitimate literal elsewhere in this file: it is a
 * FreeScanCapCode member, and `cap.code !== "ok"` at step 9 is correct. The
 * two vocabularies collide on one word, which is how the mistake happened.)
 */
/**
 * One shown signal, AS IT GOES OVER THE WIRE.
 *
 * Four fields, because those are the four src/components/free-scan-panel.tsx
 * renders: SignalRow prints label, severity and detail, and `id` is its React
 * key (free-scan-panel.tsx:942) and is never displayed.
 *
 * NOT FraudSignal. That type carries `weight`, and the panel's own docstring
 * argues at length that weights and weighted-sum language must never reach a
 * free-scan reader — while the response was handing both to an
 * unauthenticated caller. Only the two SHOWN weights ever leaked
 * (`selectTeaserSignals` returns the teaser subset, so the withheld signals
 * are never serialised and the total cannot be reconstructed), which makes
 * this minimisation rather than a paywall hole. It is still the component and
 * the payload disagreeing about what the surface is allowed to say.
 */
export type FreeScanTeaserSignal = Pick<
  FraudSignal,
  "id" | "label" | "severity" | "detail"
>;

export type FreeScanResponse = {
  score: number;
  severity: ReturnType<typeof scoreSeverity>;
  vision_status: VisionStatus;
  signals: FreeScanTeaserSignal[];
  total_signal_count: number;
};

export type FreeScanErrorResponse = {
  code: string;
  message: string;
  resetAt?: number | null;
};

// Every refusal carries a stable `code` plus copy written for a stranger who
// has not signed up. None of these read as an error page: each one points at
// the thing they can do next, because this surface's only job is conversion.
function refuse(
  status: number,
  code: string,
  message: string,
): NextResponse<FreeScanErrorResponse> {
  return NextResponse.json({ code, message }, { status });
}

/** Human copy per cap outcome. Keyed on the decision, never on the counter. */
const CAP_COPY: Record<Exclude<FreeScanCapCode, "ok">, string> = {
  ip_capped:
    "You have used all 3 free scans from this connection. Create a free account to keep scanning.",
  site_capped:
    "Today's free scans have all been used. Create a free account to scan your document now, or try again tomorrow.",
  cap_unavailable:
    "Free scans are temporarily unavailable. Create a free account to scan your document now.",
};

/**
 * The site-wide result for a request that never consulted the site-wide
 * counter.
 *
 * It inherits the per-IP enforcement mode rather than claiming a trustworthy
 * "upstash" reading: `decideFreeScanCap` keys its degraded and
 * limiter-missing branches off BOTH results, so a fabricated healthy value
 * here would report an outage as `ip_capped`, and would do the same to a
 * production deploy that has no working limiter at all.
 */
function notConsulted(perIp: RateLimitResult): RateLimitResult {
  return {
    success: true,
    remaining: 0,
    enforcement: perIp.enforcement,
    resetAt: null,
  };
}

// The upload field. zod (v4 — `.issues`, never `.errors`) owns the shape check
// so a malformed multipart body cannot reach the gates below as `undefined`.
// The MIME, size and decode rules are deliberately NOT folded in here: they
// must fire in a fixed order with distinct codes, and a schema reports all of
// its issues at once.
const freeScanUploadSchema = z.object({
  file: z.instanceof(File),
});

export async function POST(request: Request) {
  // 1. CONFIGURATION CHECK, BEFORE ANY TOKEN IS CONSUMED.
  //    Per .claude/stacks/framework/nextjs.md:556. Without the key every
  //    request would still pass both counters, run no AI call, and return a
  //    metadata-only verdict — i.e. a misconfigured deploy would spend the
  //    whole site's daily allowance and every visitor's personal allowance on
  //    scans that could never have happened. Read at request time, not at
  //    module load, so the value reflects the live environment.
  if (!process.env.ANTHROPIC_API_KEY) {
    return refuse(
      503,
      "not_configured",
      "The instant scan is unavailable right now. Create a free account and we will scan your document as soon as it is back.",
    );
  }

  // 2. Parse the multipart body and validate its shape.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return refuse(400, "invalid_request", "That upload could not be read. Please try again.");
  }

  const parsed = freeScanUploadSchema.safeParse({ file: form.get("file") });
  if (!parsed.success) {
    // zod v4 exposes `.issues`; `.errors` does not exist on ZodError here.
    // Logged, not returned — a generic body avoids leaking the schema
    // (OWASP A4-InfoLeakage), matching /api/scan's ZodError handling.
    console.warn(
      "[free-scan] invalid upload:",
      parsed.error.issues.map((i) => i.code).join(","),
    );
    return refuse(400, "invalid_request", "Please choose an image of a document to scan.");
  }
  const { file } = parsed.data;

  // 3. STRICT MIME ALLOW-LIST — images only, and a BLANK TYPE IS REFUSED.
  //
  //    /api/scan:210 admits an empty `file.type` on purpose
  //    (`!ACCEPTED_MIME.has(file.type) && file.type !== ""`), because an
  //    authenticated user with a browser that reports no type should not be
  //    blocked. THIS ROUTE DELIBERATELY DIVERGES. A blank-type PDF would
  //    otherwise slip past the refusal surface below, be treated as an image,
  //    fail EXIF extraction into `missing_exif_metadata`, and hand the visitor
  //    a confident suspect/fraud verdict on a document nothing ever looked at
  //    — after spending both their token and a site-wide one. On an anonymous
  //    surface whose entire purpose is proving the scan is real, a bogus
  //    verdict is the worst available outcome.
  //
  //    PDFs get their own code and their own copy: they are supported by the
  //    product, just not for free, so the refusal is a signup prompt rather
  //    than a dead end.
  if (file.type === "application/pdf") {
    return refuse(
      415,
      "pdf_not_supported",
      "PDF scanning comes with a free account — the instant scan here takes JPEG, PNG and WebP images. Sign up to scan this PDF.",
    );
  }
  if (!file.type || !ANON_ACCEPTED_MIME.has(file.type)) {
    return refuse(
      415,
      "unsupported_type",
      "That file type is not supported here. Upload a JPEG, PNG or WebP image of the document.",
    );
  }

  // 4. Size gates. Both are above the counters, so neither costs the visitor
  //    or the site anything.
  if (file.size === 0) {
    return refuse(400, "empty_file", "That file is empty. Please choose another image.");
  }
  if (file.size > MAX_ANON_BYTES) {
    return refuse(
      413,
      "file_too_large",
      "That image is over 4 MB. Create a free account for larger uploads, or try a smaller image.",
    );
  }

  // 5. COARSE PER-IP REQUEST COUNTER — PRICES THE DECODE, NOT THE SCAN.
  //
  //    Consumed here: below the cheap refusals (API key, zod, MIME, size), so
  //    none of those start costing budget, and ABOVE the buffer read and the
  //    decode, so the expensive work is the thing it actually meters. Move it
  //    below `prepareImage` and the decode is free again, which is the whole
  //    defect it closes.
  //
  //    IT IS NOT PART OF THE SCAN ALLOWANCE and is deliberately NOT folded
  //    into decideFreeScanCap: that function answers "what has this caller
  //    used of its 3 scans / the site's 30" and owns exactly three cap
  //    codes. A request counter answers a different question, so it gets its
  //    own code (`too_many_requests`) and its own copy. Keeping it out also
  //    keeps decideFreeScanCap a pure, exhaustively tested function of two
  //    rate-limit results.
  //
  //    Keyed via clientIpFromHeaders, never the raw X-Forwarded-For — every
  //    entry before the last is client-supplied, so reading the header
  //    directly would let an attacker mint a fresh 20-request budget per
  //    request and put the decode straight back to being free (issue #1361,
  //    CVSS-medium).
  const ip = clientIpFromHeaders(request.headers);
  const perIpRequests = await rateLimit(
    `free-scan:req:${ip}`,
    REQ_MAX,
    REQ_WINDOW_SEC,
  );
  if (!perIpRequests.success) {
    // No degraded/unconfigured branch here on purpose. This is a coarse brake
    // on CPU, not a spend gate: the in-memory fallback is imperfect across
    // cold starts but still bounds a single process, and the money question —
    // "may this request run a billed AI call at all" — is answered below by
    // decideFreeScanCap, which DOES fail closed on a degraded limiter.
    const headers: Record<string, string> = {};
    if (perIpRequests.resetAt !== null) {
      const seconds = Math.max(
        1,
        Math.ceil((perIpRequests.resetAt - Date.now()) / 1000),
      );
      headers["Retry-After"] = String(seconds);
    }
    return NextResponse.json(
      {
        code: "too_many_requests",
        message:
          "That is a lot of uploads in a short time. Wait a few minutes, or create a free account to keep scanning now.",
        resetAt: perIpRequests.resetAt,
      },
      { status: 429, headers },
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());

  // 6. DECODE GATE — the security fix, not a nicety. DO NOT "SIMPLIFY" AWAY.
  //
  //    sharp's prebuilt binaries ship WITHOUT HEIF support, so a HEIC photo —
  //    the default camera format on every iPhone — returns null here. So does
  //    a truncated JPEG and anything mislabelled `image/png`. Every one of
  //    those reaches NO Anthropic API at all: `analyzeDocumentForFraud` calls
  //    this same `prepareImage` internally and gives up before the request.
  //
  //    Without this gate those requests still consume both SCAN counters.
  //    Thirty junk uploads is then a free 24-hour denial of the landing
  //    page's primary CTA, at zero cost and zero risk to the sender.
  //    Running the decode here, ABOVE the scan counters, is what makes that
  //    impossible. The price of that ordering is that the decode itself is
  //    unmetered, which is what step 5 now charges for.
  //
  //    IT ALSO SNIFFS THE REAL FORMAT, and that part is a security fix of its
  //    own. Step 3 above checks `file.type` — the CLIENT-SUPPLIED multipart
  //    Content-Type — so "images only" was a claim about a LABEL, not about
  //    the bytes. sharp decodes SVG, TIFF, GIF and AVIF whatever the label
  //    says, and an SVG is not a bounded raster: a 0.02 MB file of ~300
  //    stacked `feGaussianBlur` layers was measured at 229,141 ms in this
  //    exact chain, i.e. one request burns the whole 60s budget, answers 504,
  //    and `free-scan:req:` allows 20 of them per IP per hour.
  //
  //    The policy is OPT-IN (lib/fraud/vision.ts `DecodePolicy`) and ONLY THIS
  //    ROUTE PASSES IT. /api/scan reaches the same function through
  //    analyzeDocumentForFraud and must keep accepting whatever sharp accepts,
  //    including an upload with a blank type — tightening it there would be a
  //    behaviour change on the paid path.
  //
  //    Cheap before expensive: `metadata()` reads the header (23 ms on the
  //    bomb above; its render was 47,959 ms at 40 layers on this install),
  //    because librsvg reports the document's size without rasterizing a
  //    single filter. MAX_ANON_INPUT_PIXELS rides along as defence in depth
  //    for the other shape of the problem — a legitimate format whose pixel
  //    count is the attack. It does NOT cover the SVG: ~4 megapixels.
  //
  //    An SVG, a TIFF and a multi-frame animation all land on the SAME
  //    `image_unreadable` refusal as a HEIC. That is deliberate: the copy is
  //    conversion-framed ("try a JPEG or PNG"), which is the useful answer for
  //    every one of them, and a distinct code would only tell a prober which
  //    of our gates it hit.
  //
  //    The decoded buffer is then handed to the pipeline so the same bytes are
  //    not decoded twice.
  const prepared = await prepareImage(buf, {
    allowedFormats: ANON_DECODE_FORMATS,
    limitInputPixels: MAX_ANON_INPUT_PIXELS,
  });
  if (!prepared) {
    return refuse(
      415,
      "image_unreadable",
      "We could not read that image — try a JPEG or PNG. iPhone photos often save as HEIC; exporting or sharing one converts it.",
    );
  }

  // 7. PER-IP SCAN COUNTER FIRST.
  //
  //    Same trusted `ip` the request counter above was keyed on. This is the
  //    SCAN allowance — 3 per 24h — and it is reached only by a request that
  //    decoded successfully, so a HEIC never costs one.
  const perIp = await rateLimit(`free-scan:ip:${ip}`, IP_MAX, WINDOW_SEC);

  // 8. SITE-WIDE COUNTER SECOND, AND ONLY IF THE PER-IP CHECK LEFT ROOM.
  //
  //    rateLimit() HAS NO PEEK — every call consumes. Reversing these two
  //    lines therefore means a single IP already over its own limit burns a
  //    site-wide token on every one of its refused requests, draining all 30
  //    of the day's free scans for everybody else. Nothing in the response
  //    would change, which is why tests/free-scan-route.test.ts (g) asserts
  //    the CALL COUNT: the absence of the second call is the only observable
  //    form this guarantee has.
  //
  //    Consuming the global token AFTER the scan instead is not a safe
  //    alternative: once the window fills, every later request would pay for
  //    a scan and then be refused.
  const siteWide = perIp.success
    ? await rateLimit(GLOBAL_KEY, SITE_MAX, WINDOW_SEC)
    : notConsulted(perIp);

  // 9. One decision from the two scan counters (lib/free-scan-cap.ts). isProduction
  //    rather than "are the Upstash vars set": preview deploys are public URLs
  //    with Production-scoped vars, and keying on var absence would leave them
  //    uncapped, while failing closed on absence everywhere would kill the
  //    feature in dev, vitest and Playwright.
  const cap = decideFreeScanCap({
    perIp,
    siteWide,
    isProduction: process.env.NODE_ENV === "production",
  });

  if (!cap.allow && cap.code !== "ok") {
    // resetAt is epoch ms and is null for cap_unavailable — there is no window
    // to wait for when the real count is unknown — so Retry-After is emitted
    // only when a reset time actually exists.
    const headers: Record<string, string> = {};
    if (cap.resetAt !== null) {
      const seconds = Math.max(1, Math.ceil((cap.resetAt - Date.now()) / 1000));
      headers["Retry-After"] = String(seconds);
    }
    return NextResponse.json(
      { code: cap.code, message: CAP_COPY[cap.code], resetAt: cap.resetAt },
      { status: 429, headers },
    );
  }

  // 10. THE ONLY AI CALL IN THIS HANDLER. runFraudScan makes exactly one
  //    content pass; calling analyzeDocumentForFraud here as well would
  //    double the cost per visitor and halve the real value of both caps.
  const { score, signals, vision } = await runFraudScan({
    buf,
    filename: file.name,
    mime: file.type,
    preparedImage: prepared,
  });

  // 11. Score, band, and TWO signals.
  //
  //     severity comes from scoreSeverity — the shared 34/67 bands. There are
  //     already three copies of those thresholds in the codebase and a fourth
  //     is how the free panel starts disagreeing with the dashboard about the
  //     same document.
  //
  //     selectTeaserSignals rather than signals.slice(0, 2): vision findings
  //     are appended LAST by applyVisionSignals, so slicing shows two
  //     innocuous metadata rows and always withholds the AI finding — a
  //     confident "87 / likely forged" above evidence that does not support
  //     it, on the one surface whose job is proving the scan is real.
  //
  //     The shown pair is PROJECTED to the four fields the panel renders.
  //     `weight` is dropped on the wire, not in selectTeaserSignals: that
  //     function ranks BY weight and stays a pure function of FraudSignal.
  const response: FreeScanResponse = {
    score,
    severity: scoreSeverity(score),
    vision_status: vision.status,
    signals: selectTeaserSignals(signals, TEASER_SIGNAL_COUNT).map(
      ({ id, label, severity, detail }) => ({ id, label, severity, detail }),
    ),
    total_signal_count: signals.length,
  };

  // 12. WHAT THE SCAN COST, SERVER-SIDE ONLY.
  //
  //     This used to ride on the response as `usage` so the panel could put
  //     the token counts on free_scan_complete. Billing telemetry and a model
  //     name are not the visitor's business — and token counts handed back to
  //     the caller are a measuring tape for cost-amplification — so they come
  //     off the wire and are logged here instead.
  //
  //     THE TRADE-OFF IS REAL AND DELIBERATE: nothing is persisted for an
  //     anonymous scan, so this line is now the ONLY record of what the free
  //     tier spends, and it lives in the platform's runtime logs rather than
  //     in PostHog where it could be grouped by variant or joined to the
  //     funnel. h-12 itself (free_scan_complete / free_scan_start) is
  //     unaffected — it never read these numbers. experiment/EVENTS.yaml and
  //     lib/events.ts were updated in the same change, because an event
  //     declaring properties nothing sends is worse than the exposure was.
  //
  //     Logged only when a request actually reached the model. Zeros would be
  //     a lie about what happened: not billed is not the same as billed
  //     nothing. `console.info`, not an analytics call — a server-side emit
  //     would attribute an anonymous visitor to a server distinct id.
  if (vision.usage) {
    console.info("[free-scan] vision usage", JSON.stringify(vision.usage));
  }

  return NextResponse.json(response, { status: 200 });
}
