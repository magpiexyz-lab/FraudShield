import { describe, it, expect } from "vitest";
import { computeQuota } from "./quota";
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
    const result = computeQuota({
      scans_used: 2,
      subscription: { status: "past_due", scan_quota: 100 },
    });
    expect(result.is_paid).toBe(false);
    // past_due falls back to free quota — 2 used, free quota = 3, so still allowed
    expect(result.allowed).toBe(true);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
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
