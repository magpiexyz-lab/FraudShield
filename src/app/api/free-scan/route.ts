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
// two counters — 3 per IP per 24h, 30 per day site-wide — so THE ORDER OF THE
// GATES BELOW IS PART OF THE SECURITY MODEL, not a style choice. Each step
// documents what goes wrong if it moves.
//
// Deliberately absent:
//   - No Supabase, no `subscriptions` read, no computeQuota/scanWindowStart.
//     An IP cap is not a user quota, and the entitlement machinery exists to
//     answer "what has this ACCOUNT paid for", a question with no answer here.
//   - No analytics. The three `free_scan_*` events fire from the client
//     component that owns the panel; a server-side emit would attribute an
//     anonymous visitor to a server distinct id, and `activate` must never
//     fire for someone who has not signed up.
//   - No persistence. There is no migration for anonymous scans and
//     `scans.user_id` is `not null references auth.users`.
//   - Images only, 4 MB — see ANON_ACCEPTED_MIME / MAX_ANON_BYTES in
//     lib/scan-intake.ts. Stricter than the authenticated path on purpose.

import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { decideFreeScanCap, type FreeScanCapCode } from "@/lib/free-scan-cap";
import { selectTeaserSignals } from "@/lib/free-scan-teaser";
import { runFraudScan } from "@/lib/fraud/run-scan";
import { prepareImage } from "@/lib/fraud/vision";
import { scoreSeverity } from "@/lib/fraud/score";
import { ANON_ACCEPTED_MIME, MAX_ANON_BYTES } from "@/lib/scan-intake";
import type { FraudSignal } from "@/lib/types";
import type { RateLimitResult } from "@/lib/rate-limit";

// sharp (the decode gate) and Buffer are Node APIs — pin the runtime rather
// than relying on the default. maxDuration covers the AI content pass, which
// budgets up to 25s of its own before falling back. Mirrors /api/scan:40-41.
export const runtime = "nodejs";
export const maxDuration = 60;

/** How many of the forensic signals the free scan shows. The rest are teased. */
const TEASER_SIGNAL_COUNT = 2;

/** Per-IP: 3 scans per rolling 24h. */
const IP_MAX = 3;
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
 */
export type FreeScanResponse = {
  score: number;
  severity: ReturnType<typeof scoreSeverity>;
  vision_status: string;
  signals: FraudSignal[];
  total_signal_count: number;
  usage?: { input_tokens: number; output_tokens: number; model: string };
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
      "PDF scanning comes with a free account — the instant scan here takes JPEG and PNG images. Sign up to scan this PDF.",
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

  const buf = Buffer.from(await file.arrayBuffer());

  // 5. DECODE GATE — the security fix, not a nicety. DO NOT "SIMPLIFY" AWAY.
  //
  //    sharp's prebuilt binaries ship WITHOUT HEIF support, so a HEIC photo —
  //    the default camera format on every iPhone — returns null here. So does
  //    a truncated JPEG and anything mislabelled `image/png`. Every one of
  //    those reaches NO Anthropic API at all: `analyzeDocumentForFraud` calls
  //    this same `prepareImage` internally and gives up before the request.
  //
  //    Without this gate those requests still consume both counters. Thirty
  //    junk uploads is then a free 24-hour denial of the landing page's
  //    primary CTA, at zero cost and zero risk to the sender. Running the
  //    decode here, ABOVE the counters, is what makes that impossible.
  //
  //    The decoded buffer is then handed to the pipeline so the same bytes are
  //    not decoded twice.
  const prepared = await prepareImage(buf);
  if (!prepared) {
    return refuse(
      415,
      "image_unreadable",
      "We could not read that image — try a JPEG or PNG. iPhone photos often save as HEIC; exporting or sharing one converts it.",
    );
  }

  // 6. PER-IP COUNTER FIRST.
  //
  //    Keyed via clientIpFromHeaders, never the raw X-Forwarded-For: entries
  //    before the last one are client-supplied, so reading the header directly
  //    lets an attacker mint a fresh 3-scan allowance per request
  //    (issue #1361, CVSS-medium).
  const ip = clientIpFromHeaders(request.headers);
  const perIp = await rateLimit(`free-scan:ip:${ip}`, IP_MAX, WINDOW_SEC);

  // 7. SITE-WIDE COUNTER SECOND, AND ONLY IF THE PER-IP CHECK LEFT ROOM.
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

  // 8. One decision from the two counters (lib/free-scan-cap.ts). isProduction
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

  // 9. THE ONLY AI CALL IN THIS HANDLER. runFraudScan makes exactly one
  //    content pass; calling analyzeDocumentForFraud here as well would
  //    double the cost per visitor and halve the real value of both caps.
  const { score, signals, vision } = await runFraudScan({
    buf,
    filename: file.name,
    mime: file.type,
    preparedImage: prepared,
  });

  // 10. Score, band, and TWO signals.
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
  const response: FreeScanResponse = {
    score,
    severity: scoreSeverity(score),
    vision_status: vision.status,
    signals: selectTeaserSignals(signals, TEASER_SIGNAL_COUNT),
    total_signal_count: signals.length,
    // Present only when a request actually reached the model. Spread rather
    // than set to null so a scan that never got there reads as "not measured"
    // instead of "billed nothing", which never happens.
    ...(vision.usage ? { usage: vision.usage } : {}),
  };

  return NextResponse.json(response, { status: 200 });
}
