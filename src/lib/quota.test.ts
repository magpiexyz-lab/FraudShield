import { describe, it, expect } from "vitest";
import { computeQuota, currentPeriodStart } from "./quota";
import { FREE_SCAN_QUOTA } from "./types";

describe("computeQuota — free tier", () => {
  it("allows scan when scans_used < FREE_SCAN_QUOTA", () => {
    const result = computeQuota({ scans_used: 0, subscription: null });
    expect(result.allowed).toBe(true);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
    expect(result.remaining).toBe(FREE_SCAN_QUOTA);
    expect(result.is_paid).toBe(false);
  });

  it("allows scan when scans_used is one below the limit", () => {
    const result = computeQuota({ scans_used: FREE_SCAN_QUOTA - 1, subscription: null });
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
  });

  it("denies scan when scans_used equals FREE_SCAN_QUOTA", () => {
    const result = computeQuota({ scans_used: FREE_SCAN_QUOTA, subscription: null });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("denies scan when scans_used exceeds FREE_SCAN_QUOTA", () => {
    const result = computeQuota({ scans_used: FREE_SCAN_QUOTA + 5, subscription: null });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe("computeQuota — paid subscription", () => {
  it("allows scan when scans_used < subscription scan_quota", () => {
    const result = computeQuota({
      scans_used: 5,
      subscription: { status: "active", scan_quota: 100 },
    });
    expect(result.allowed).toBe(true);
    expect(result.total_quota).toBe(100);
    expect(result.remaining).toBe(95);
    expect(result.is_paid).toBe(true);
  });

  it("denies scan when scans_used equals subscription scan_quota", () => {
    const result = computeQuota({
      scans_used: 100,
      subscription: { status: "active", scan_quota: 100 },
    });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("denies scan when subscription status is 'inactive'", () => {
    const result = computeQuota({
      scans_used: 0,
      subscription: { status: "inactive", scan_quota: 100 },
    });
    // Inactive subscription falls back to free quota behaviour
    expect(result.is_paid).toBe(false);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
  });

  it("denies scan when subscription status is 'canceled'", () => {
    const result = computeQuota({
      scans_used: FREE_SCAN_QUOTA,
      subscription: { status: "canceled", scan_quota: 100 },
    });
    expect(result.is_paid).toBe(false);
    expect(result.allowed).toBe(false);
  });

  it("denies scan when subscription status is 'past_due'", () => {
    // Derived from FREE_SCAN_QUOTA rather than a literal. This test previously
    // hardcoded scans_used: 2 alongside a comment reading "free quota = 3", and
    // broke the moment the quota changed — it was asserting the constant's
    // value, not the behaviour it exists to describe. What matters here is that
    // past_due falls back to the FREE allowance whatever that allowance is.
    const result = computeQuota({
      scans_used: FREE_SCAN_QUOTA - 1,
      subscription: { status: "past_due", scan_quota: 100 },
    });
    expect(result.is_paid).toBe(false);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
    // One scan left of the free allowance, so still allowed.
    expect(result.allowed).toBe(true);

    // And denied once the free allowance is spent.
    const spent = computeQuota({
      scans_used: FREE_SCAN_QUOTA,
      subscription: { status: "past_due", scan_quota: 100 },
    });
    expect(spent.allowed).toBe(false);
  });
});

describe("computeQuota — edge cases", () => {
  it("does not return negative remaining", () => {
    const result = computeQuota({
      scans_used: 999,
      subscription: null,
    });
    expect(result.remaining).toBe(0);
    expect(result.allowed).toBe(false);
  });

  it("FREE_SCAN_QUOTA is a positive integer", () => {
    expect(FREE_SCAN_QUOTA).toBeGreaterThan(0);
    expect(Number.isInteger(FREE_SCAN_QUOTA)).toBe(true);
  });
});

// The Pro plan sells "200 document scans / month". Usage used to be counted
// all-time, so a subscriber got 200 scans EVER and month two was paid for but
// empty. These pin the window arithmetic that makes the quota genuinely monthly.
describe("currentPeriodStart — monthly quota window", () => {
  const anchor = new Date("2026-01-15T10:00:00.000Z");

  it("returns the anchor while still inside the first period", () => {
    const now = new Date("2026-01-20T00:00:00.000Z");
    expect(currentPeriodStart(anchor, now).toISOString()).toBe(anchor.toISOString());
  });

  it("returns the anchor at the very last instant before renewal", () => {
    const now = new Date("2026-02-15T09:59:59.999Z");
    expect(currentPeriodStart(anchor, now).toISOString()).toBe(anchor.toISOString());
  });

  it("advances exactly on the renewal instant", () => {
    const now = new Date("2026-02-15T10:00:00.000Z");
    expect(currentPeriodStart(anchor, now).toISOString()).toBe(
      "2026-02-15T10:00:00.000Z",
    );
  });

  it("lands in the right window many months later", () => {
    const now = new Date("2026-07-20T00:00:00.000Z");
    expect(currentPeriodStart(anchor, now).toISOString()).toBe(
      "2026-07-15T10:00:00.000Z",
    );
  });

  it("never returns a window start in the future", () => {
    const now = new Date("2026-05-01T00:00:00.000Z");
    expect(currentPeriodStart(anchor, now).getTime()).toBeLessThanOrEqual(
      now.getTime(),
    );
  });

  it("clamps a month-end anchor instead of skidding forward", () => {
    // 31 Jan + 1 month via setUTCMonth lands on 3 Mar, which would hand the
    // subscriber a free extra window every short month.
    const endOfMonth = new Date("2026-01-31T12:00:00.000Z");
    const inFebruary = new Date("2026-02-28T13:00:00.000Z");
    const start = currentPeriodStart(endOfMonth, inFebruary);
    expect(start.getUTCMonth()).toBe(1);
    expect(start.getUTCDate()).toBe(28);
    expect(start.getTime()).toBeLessThanOrEqual(inFebruary.getTime());
  });

  it("treats a future anchor as the window start", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(currentPeriodStart(anchor, now).toISOString()).toBe(anchor.toISOString());
  });
});
