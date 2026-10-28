import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The dashboard computes its quota meter in the browser, and vitest runs with
 * environment "node" with no jsdom in this project, so the component cannot be
 * rendered here. These assert on the source instead -- which is the right level
 * anyway, because the defect being pinned was a query shape, not a render.
 *
 * REGRESSION. Commit c092056 fixed the identical status-filter bug in
 * src/app/api/scan/route.ts and touched no other file, so the dashboard kept
 * reading subscriptions the old way: filtered to status "active" and without
 * scan_credits. Every scan-pack buyer was charged and then shown an exhausted
 * paywall offering to sell them more scans. Both live paying customers hit it.
 */

function read(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8");
}

/** Strip line and block comments so a test can never match its own prose. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const DASHBOARD = stripComments(read("src", "app", "dashboard", "page.tsx"));
const SCAN_ROUTE = stripComments(read("src", "app", "api", "scan", "route.ts"));
const QUOTA = stripComments(read("src", "lib", "quota.ts"));
const SCAN_RESULT = stripComments(
  read("src", "app", "scan-result", "scan-result-client.tsx"),
);

describe("dashboard quota read — regression", () => {
  it("does not filter the subscriptions read to active rows", () => {
    // The exact defect: a pack buyer's status is "inactive", so this filter
    // hid the row that carried the scans they had just paid for.
    expect(DASHBOARD).not.toContain('.eq("status", "active")');
  });

  it("selects scan_credits, without which credits can never be counted", () => {
    expect(DASHBOARD).toContain("scan_credits");
  });

  it("selects the billing anchor so a subscriber's window can be applied", () => {
    expect(DASHBOARD).toContain("current_period_start");
  });

  it("derives the allowance from computeQuota rather than its own arithmetic", () => {
    expect(DASHBOARD).toContain("computeQuota");
    expect(DASHBOARD).toContain("@/lib/quota");
  });

  it("uses the shared window helper rather than re-inlining the anchor rule", () => {
    expect(DASHBOARD).toContain("scanWindowStart");
  });

  it("still excludes partial image analyses from the used count", () => {
    // 005_scans_counts_toward_quota.sql — a partial scan is refunded, so the
    // meter must not show it as spent. Unrelated to this fix; pinned so the
    // rewrite of this effect cannot quietly drop it.
    expect(DASHBOARD).toContain('counts_toward_quota", true');
  });
});

describe("dashboard paid-state derivation — regression", () => {
  it("gates the billing portal on is_paid, not on a raised total", () => {
    // Once credits count toward the total, `total > FREE_SCAN_QUOTA` is true
    // for a pack buyer, which would render Manage billing at someone with no
    // subscription for the portal to manage.
    expect(DASHBOARD).not.toContain("quota.total > FREE_SCAN_QUOTA");
    expect(DASHBOARD).toContain("is_paid");
  });

  it("does not describe purchased scans as free scans", () => {
    expect(DASHBOARD).not.toContain("free scans.");
  });

  it("does not label a pack buyer's quota meter as free scans", () => {
    // The meter is visible on every load, not only when the allowance is
    // spent, so labelling it on isPaid alone made the same false claim as the
    // exhausted card to anyone who had bought a pack.
    expect(DASHBOARD).not.toContain('{isPaid ? "Scans" : "Free scans"}');
    expect(DASHBOARD).toContain('isPaid || purchased ? "Scans" : "Free scans"');
  });
});

describe("quota module — shared ownership of the window rule", () => {
  it("exports scanWindowStart", () => {
    expect(QUOTA).toContain("export function scanWindowStart");
  });

  it("keeps the active-status gate that makes the anchor safe to trust", () => {
    // Without it, someone who cancelled and later bought a pack would have
    // usage counted from this month only, and would be re-granted their free
    // scan plus the whole pack every month, forever.
    const start = QUOTA.indexOf("export function scanWindowStart");
    expect(start).toBeGreaterThan(-1);
    expect(QUOTA.slice(start, start + 900)).toContain('"active"');
  });
});

describe("scan route — unchanged entitlement behaviour", () => {
  it("still reads the subscriptions row without a status filter", () => {
    expect(SCAN_ROUTE).not.toContain('.eq("status", "active")');
  });

  it("delegates the window decision to the shared helper", () => {
    expect(SCAN_ROUTE).toContain("scanWindowStart");
  });

  it("still refuses a scan when computeQuota says the allowance is spent", () => {
    expect(SCAN_ROUTE).toContain("quota.allowed");
    expect(SCAN_ROUTE).toContain("402");
  });
});

// REGRESSION -- the SECOND credit-blind quota copy.
//
// The dashboard was not the only surface deriving quota by hand. /scan-result
// is where a user lands after EVERY scan, and it computed exhaustion as
// scansUsed >= FREE_SCAN_QUOTA -- an all-time count against the free
// allowance, ignoring scan_credits and scan_quota entirely. A pack buyer with
// 7 scans left was told "You have used all 1 free scans" and shown the buy
// button, which is the likeliest place the production triple-charge happened.
describe("scan-result quota read -- regression", () => {
  it("does not derive exhaustion from a raw scan count", () => {
    expect(SCAN_RESULT).not.toContain("scansUsed >= FREE_SCAN_QUOTA");
  });

  it("selects the credit and allowance columns, not just status", () => {
    expect(SCAN_RESULT).toContain("scan_credits");
    expect(SCAN_RESULT).toContain("scan_quota");
    expect(SCAN_RESULT).toContain("current_period_start");
  });

  it("derives the allowance from computeQuota, the same authority as /api/scan", () => {
    expect(SCAN_RESULT).toContain("computeQuota");
    expect(SCAN_RESULT).toContain("@/lib/quota");
  });

  it("applies the shared billing window to the scan count", () => {
    expect(SCAN_RESULT).toContain("scanWindowStart");
  });

  it("still excludes partial image analyses from the used count", () => {
    expect(SCAN_RESULT).toContain('counts_toward_quota", true');
  });

  it("does not tell a pack buyer their purchased scans were free", () => {
    expect(SCAN_RESULT).not.toContain("used all {FREE_SCAN_QUOTA} free scans");
  });

  it("does not compute the remaining count from FREE_SCAN_QUOTA alone", () => {
    expect(SCAN_RESULT).not.toContain("FREE_SCAN_QUOTA - scansUsed");
  });

  it("keeps the Pro breakdown gate on status alone, which is correct", () => {
    // A pack buyer genuinely is not Pro, so hasProAccess must NOT start
    // counting credits -- that gate answers a different question.
    expect(SCAN_RESULT).toContain("hasProAccess");
  });
});
