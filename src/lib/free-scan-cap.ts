// Cap decision for the anonymous free scan.
//
// The free scan spends real money per request (one `claude-opus-5` vision
// call), is unauthenticated, and is reachable by anyone with the URL. Two
// counters guard it — 3 per IP per 24h and 30 per day site-wide — and this
// module turns the two raw `rateLimit()` results into a single decision.
//
// Pure and synchronous on purpose: no I/O, no `Date.now()`, no `process.env`.
// Everything that varies is an argument, so every branch below is directly
// testable (see tests/free-scan-cap.test.ts).

import type { RateLimitResult } from "@/lib/rate-limit";

export type FreeScanCapCode =
  | "ok"
  | "ip_capped"
  | "site_capped"
  | "cap_unavailable";

export type FreeScanCapDecision = {
  allow: boolean;
  code: FreeScanCapCode;
  resetAt: number | null;
};

export function decideFreeScanCap(input: {
  perIp: RateLimitResult;
  siteWide: RateLimitResult;
  isProduction: boolean;
}): FreeScanCapDecision {
  const { perIp, siteWide, isProduction } = input;

  // 1. Upstash is configured but threw. The real count is unknown, so refuse
  //    in EVERY environment rather than run billed AI calls uncapped.
  if (
    perIp.enforcement === "memory_degraded" ||
    siteWide.enforcement === "memory_degraded"
  ) {
    return { allow: false, code: "cap_unavailable", resetAt: null };
  }

  // 2. A production deployment with no working limiter fails closed.
  //
  //    This keys on an `isProduction` flag (the route passes
  //    `process.env.NODE_ENV === "production"`) rather than on "are the
  //    Upstash env vars set". That distinction is deliberate and is the part
  //    that gets "simplified" away:
  //
  //    A Vercel PREVIEW deployment is a public URL serving real traffic, and
  //    this project's Upstash vars are Production-scoped — so previews legitimately
  //    have no external counter. Keying on env-var absence would therefore
  //    leave every preview deploy running uncapped `claude-opus-5` calls for
  //    anyone holding the URL. Keying on NODE_ENV instead means previews fall
  //    back to the process-local counter (imperfect across cold starts, but
  //    bounded) while real production still refuses to serve without one.
  //
  //    The inverse mistake is just as bad: do NOT make an unconfigured
  //    limiter fail closed everywhere, or the free scan becomes 100% dead in
  //    dev, vitest and Playwright.
  const limiterMissing =
    perIp.enforcement !== "upstash" || siteWide.enforcement !== "upstash";
  if (limiterMissing && isProduction) {
    return { allow: false, code: "cap_unavailable", resetAt: null };
  }

  // 3. Per-IP before site-wide. The route also consumes the counters in this
  //    order, so a single abusive IP is rejected by its own cap and cannot
  //    drain the global daily budget through requests that never run a scan.
  if (!perIp.success) {
    return { allow: false, code: "ip_capped", resetAt: perIp.resetAt };
  }

  // 4. Site-wide budget exhausted: everyone waits, including first-time IPs.
  if (!siteWide.success) {
    return { allow: false, code: "site_capped", resetAt: siteWide.resetAt };
  }

  // 5. Both counters had room.
  return { allow: true, code: "ok", resetAt: null };
}
