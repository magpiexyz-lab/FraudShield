import { describe, expect, it } from "vitest";

import {
  decideFreeScanCap,
  type FreeScanCapCode,
} from "@/lib/free-scan-cap";
import { rateLimit, type RateLimitResult } from "@/lib/rate-limit";

// --- Fixtures ---------------------------------------------------------------

function upstashOk(remaining = 2): RateLimitResult {
  return {
    success: true,
    remaining,
    enforcement: "upstash",
    resetAt: null,
  };
}

function upstashFail(resetAt: number): RateLimitResult {
  return {
    success: false,
    remaining: 0,
    enforcement: "upstash",
    resetAt,
  };
}

function degraded(): RateLimitResult {
  return {
    success: true,
    remaining: 2,
    enforcement: "memory_degraded",
    resetAt: 9_000,
  };
}

function unconfigured(success = true): RateLimitResult {
  return {
    success,
    remaining: success ? 2 : 0,
    enforcement: "memory_unconfigured",
    resetAt: 8_000,
  };
}

describe("decideFreeScanCap", () => {
  it("allows the scan when both limiters succeed under Upstash", () => {
    const decision = decideFreeScanCap({
      perIp: upstashOk(),
      siteWide: upstashOk(29),
      isProduction: true,
    });

    expect(decision).toEqual({ allow: true, code: "ok", resetAt: null });
  });

  it("returns ip_capped with the per-IP resetAt when the per-IP limiter is exhausted", () => {
    const decision = decideFreeScanCap({
      perIp: upstashFail(1_777_000),
      siteWide: upstashOk(29),
      isProduction: true,
    });

    expect(decision).toEqual({
      allow: false,
      code: "ip_capped",
      resetAt: 1_777_000,
    });
  });

  it("returns site_capped with the site-wide resetAt when only the site budget is exhausted", () => {
    const decision = decideFreeScanCap({
      perIp: upstashOk(),
      siteWide: upstashFail(1_888_000),
      isProduction: true,
    });

    expect(decision).toEqual({
      allow: false,
      code: "site_capped",
      resetAt: 1_888_000,
    });
  });

  it("prefers ip_capped over site_capped when both are exhausted", () => {
    // Per-IP is the more specific refusal, and the route consumes per-IP
    // first so one IP cannot drain the global budget with rejected requests.
    const decision = decideFreeScanCap({
      perIp: upstashFail(1_777_000),
      siteWide: upstashFail(1_888_000),
      isProduction: true,
    });

    expect(decision.code).toBe("ip_capped");
    expect(decision.resetAt).toBe(1_777_000);
  });

  it("fails closed with cap_unavailable when the per-IP limiter is degraded, even outside production", () => {
    // Upstash IS configured but unreachable: we cannot know the real count,
    // so we must not run billed AI calls uncapped in ANY environment.
    const decision = decideFreeScanCap({
      perIp: degraded(),
      siteWide: upstashOk(29),
      isProduction: false,
    });

    expect(decision).toEqual({
      allow: false,
      code: "cap_unavailable",
      resetAt: null,
    });
  });

  it("fails closed with cap_unavailable when the site-wide limiter is degraded, even outside production", () => {
    const decision = decideFreeScanCap({
      perIp: upstashOk(),
      siteWide: degraded(),
      isProduction: false,
    });

    expect(decision.allow).toBe(false);
    expect(decision.code).toBe("cap_unavailable");
  });

  it("takes precedence of degraded over an exhausted per-IP counter", () => {
    const decision = decideFreeScanCap({
      perIp: upstashFail(1_777_000),
      siteWide: degraded(),
      isProduction: true,
    });

    expect(decision.code).toBe("cap_unavailable");
  });

  it("fails closed in production when the limiter is unconfigured", () => {
    const decision = decideFreeScanCap({
      perIp: unconfigured(),
      siteWide: unconfigured(),
      isProduction: true,
    });

    expect(decision).toEqual({
      allow: false,
      code: "cap_unavailable",
      resetAt: null,
    });
  });

  it("fails closed in production when only the site-wide limiter is unconfigured", () => {
    const decision = decideFreeScanCap({
      perIp: upstashOk(),
      siteWide: unconfigured(),
      isProduction: true,
    });

    expect(decision.code).toBe("cap_unavailable");
  });

  it("still allows scans with an unconfigured limiter outside production", () => {
    // LOAD-BEARING: dev, `vitest`, Playwright and Vercel preview all run
    // without Production-scoped Upstash vars. If this assertion is ever
    // "simplified" into failing closed on env absence, the free scan becomes
    // 100% dead everywhere except production and no test can catch it.
    const decision = decideFreeScanCap({
      perIp: unconfigured(),
      siteWide: unconfigured(),
      isProduction: false,
    });

    expect(decision).toEqual({ allow: true, code: "ok", resetAt: null });
  });

  it("honours the in-memory counters outside production once they are exhausted", () => {
    const decision = decideFreeScanCap({
      perIp: unconfigured(false),
      siteWide: unconfigured(),
      isProduction: false,
    });

    expect(decision.code).toBe("ip_capped");
    expect(decision.resetAt).toBe(8_000);
  });

  it("allows the scan only for the ok code, across every code", () => {
    const cases: Array<{
      code: FreeScanCapCode;
      input: Parameters<typeof decideFreeScanCap>[0];
    }> = [
      {
        code: "ok",
        input: {
          perIp: upstashOk(),
          siteWide: upstashOk(),
          isProduction: true,
        },
      },
      {
        code: "ip_capped",
        input: {
          perIp: upstashFail(1),
          siteWide: upstashOk(),
          isProduction: true,
        },
      },
      {
        code: "site_capped",
        input: {
          perIp: upstashOk(),
          siteWide: upstashFail(2),
          isProduction: true,
        },
      },
      {
        code: "cap_unavailable",
        input: {
          perIp: degraded(),
          siteWide: upstashOk(),
          isProduction: false,
        },
      },
      {
        code: "cap_unavailable",
        input: {
          perIp: unconfigured(),
          siteWide: unconfigured(),
          isProduction: true,
        },
      },
    ];

    const seen = new Set<FreeScanCapCode>();
    for (const { code, input } of cases) {
      const decision = decideFreeScanCap(input);
      expect(decision.code).toBe(code);
      expect(decision.allow).toBe(code === "ok");
      seen.add(code);
    }

    // Every code in the union is exercised above.
    expect([...seen].sort()).toEqual([
      "cap_unavailable",
      "ip_capped",
      "ok",
      "site_capped",
    ]);
  });
});

describe("rateLimit result shape", () => {
  // Guards the additive change to RateLimitResult: decideFreeScanCap cannot
  // distinguish "no limiter configured" from "Upstash threw" without these
  // two fields, so a silent revert would re-introduce the uncapped path.
  it("reports enforcement and resetAt", async () => {
    const result = await rateLimit(
      `free-scan-cap-shape-${Math.random()}`,
      5,
      60,
    );

    expect(result).toMatchObject({
      success: true,
      remaining: 4,
    });
    expect(result.enforcement).toBe("memory_unconfigured");
    expect(typeof result.resetAt).toBe("number");
    expect(result.resetAt).toBeGreaterThan(Date.now());
  });

  it("keeps resetAt stable across calls inside one window", async () => {
    const key = `free-scan-cap-window-${Math.random()}`;
    const first = await rateLimit(key, 2, 60);
    const second = await rateLimit(key, 2, 60);
    const third = await rateLimit(key, 2, 60);

    expect(first.resetAt).toBe(second.resetAt);
    expect(second.remaining).toBe(0);
    expect(third.success).toBe(false);
    expect(third.resetAt).toBe(first.resetAt);
    expect(third.enforcement).toBe("memory_unconfigured");
  });
});
