import { describe, it, expect } from "vitest";
import { computeQuota, currentPeriodStart, scanWindowStart } from "./quota";
import { FREE_SCAN_QUOTA } from "./types";

// computeQuota decides "is this user paid?" from the whole entitlement row, not
// from status alone: an active row with NO stripe_subscription_id is a COMPED
// grant, and a comp expires at its current_period_end. Every row below
// therefore states both columns.
//
// WHICH ROWS CARRY A STRIPE ID. active and past_due only ever arise from a
// Stripe subscription in production, so those rows name one; the pack-buyer
// ("inactive") and cancelled rows deliberately do not, which is also the shape
// a comped grant has.
const STRIPE_SUB = "sub_1QabcdEFghijkLM";

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
      subscription: {
        status: "active", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: STRIPE_SUB, current_period_end: null,
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.total_quota).toBe(100);
    expect(result.remaining).toBe(95);
    expect(result.is_paid).toBe(true);
  });

  it("denies scan when scans_used equals subscription scan_quota", () => {
    const result = computeQuota({
      scans_used: 100,
      subscription: {
        status: "active", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: STRIPE_SUB, current_period_end: null,
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("denies scan when subscription status is 'inactive'", () => {
    const result = computeQuota({
      scans_used: 0,
      subscription: {
        status: "inactive", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: null, current_period_end: null,
      },
    });
    // Inactive subscription falls back to free quota behaviour
    expect(result.is_paid).toBe(false);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
  });

  it("denies scan when subscription status is 'canceled'", () => {
    const result = computeQuota({
      scans_used: FREE_SCAN_QUOTA,
      subscription: {
        status: "canceled", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: null, current_period_end: null,
      },
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
      subscription: {
        status: "past_due", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: STRIPE_SUB, current_period_end: null,
      },
    });
    expect(result.is_paid).toBe(false);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
    // One scan left of the free allowance, so still allowed.
    expect(result.allowed).toBe(true);

    // And denied once the free allowance is spent.
    const spent = computeQuota({
      scans_used: FREE_SCAN_QUOTA,
      subscription: {
        status: "past_due", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: STRIPE_SUB, current_period_end: null,
      },
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

// REGRESSION -- scan-pack buyers locked out of scans they paid for.
//
// Both live paying customers hit this: a pack buyer's subscriptions row has
// status "inactive" (they bought scans, they did not subscribe), so the
// dashboard's own quota read filtered the row away and never selected
// scan_credits. They were charged and shown an exhausted paywall. One of them
// bought three times in a single day because the paywall kept re-offering the
// buy button after each successful payment.
//
// scanWindowStart owns the billing-window decision that /api/scan used to
// inline, so the dashboard and the API cannot drift apart again.
describe("scan-pack buyer entitlement -- regression", () => {
  it("grants a pack buyer the scans they bought despite an inactive status", () => {
    const result = computeQuota({
      scans_used: 1,
      subscription: {
        status: "inactive", scan_quota: 0, scan_credits: 7,
        stripe_subscription_id: null, current_period_end: null,
      },
    });
    expect(result.remaining).toBe(7);
    expect(result.allowed).toBe(true);
    expect(result.is_paid).toBe(false);
    expect(result.credits_remaining).toBe(7);
  });

  it("reproduces the exact five-day lockout: 1 credit bought, 1 free scan used", () => {
    const result = computeQuota({
      scans_used: 1,
      subscription: {
        status: "inactive", scan_quota: 0, scan_credits: 1,
        stripe_subscription_id: null, current_period_end: null,
      },
    });
    expect(result.remaining).toBe(1);
    expect(result.allowed).toBe(true);
  });

  it("refuses a pack buyer who has genuinely spent every scan", () => {
    const result = computeQuota({
      scans_used: 2,
      subscription: {
        status: "inactive", scan_quota: 0, scan_credits: 1,
        stripe_subscription_id: null, current_period_end: null,
      },
    });
    expect(result.remaining).toBe(0);
    expect(result.allowed).toBe(false);
  });

  it("does not widen the free allowance for a user who has bought nothing", () => {
    const result = computeQuota({ scans_used: 1, subscription: null });
    expect(result.remaining).toBe(0);
    expect(result.allowed).toBe(false);
  });

  it("never adds permanent credits to a subscriber's monthly allowance", () => {
    const result = computeQuota({
      scans_used: 0,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 5,
        stripe_subscription_id: STRIPE_SUB, current_period_end: null,
      },
    });
    expect(result.total_quota).toBe(200);
    expect(result.credits_remaining).toBe(0);
    expect(result.is_paid).toBe(true);
  });
});

// A CANCELLED subscriber keeps their old current_period_start, and
// currentPeriodStart() rolls any anchor forward to the present. Without the
// status gate, someone who cancelled and later bought a single pack would have
// usage counted from this month only -- and would receive their free scan plus
// the whole pack again every month, forever.
describe("scanWindowStart -- which scans count", () => {
  const now = new Date("2026-10-28T12:00:00.000Z");

  it("returns null for an inactive row even when an anchor is present", () => {
    expect(
      scanWindowStart(
        { status: "inactive", current_period_start: "2026-01-15T10:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("returns null for a canceled row even when an anchor is present", () => {
    expect(
      scanWindowStart(
        { status: "canceled", current_period_start: "2026-01-15T10:00:00.000Z" },
        now,
      ),
    ).toBeNull();
  });

  it("returns null when there is no row at all", () => {
    expect(scanWindowStart(null, now)).toBeNull();
  });

  it("returns null for an active subscriber with no anchor recorded", () => {
    expect(
      scanWindowStart({ status: "active", current_period_start: null }, now),
    ).toBeNull();
  });

  it("rolls an active subscriber's anchor forward to the current window", () => {
    const start = scanWindowStart(
      { status: "active", current_period_start: "2026-01-15T10:00:00.000Z" },
      now,
    );
    expect(start).not.toBeNull();
    expect(start!.toISOString()).toBe("2026-10-15T10:00:00.000Z");
  });
});

// A COMPED GRANT THAT NEVER ENDED.
//
// A comp is written by hand: status "active", a quota, and no Stripe
// subscription behind it. Status is what revokes paid access, and status is
// flipped by a WEBHOOK -- customer.subscription.deleted moves a real
// subscriber to canceled. A comp has no webhook, so nothing ever flipped it:
// once granted, it entitled its owner to the Pro monthly quota for ever.
//
// computeQuota now asks hasProAccess, which expires a Stripe-less row at its
// current_period_end. Everything else about this module is unchanged.
describe("computeQuota -- a comped grant expires", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");
  const PAST = "2026-10-01T00:00:00.000Z";
  const FUTURE = "2026-12-01T00:00:00.000Z";

  it("drops an expired comp back to the free allowance", () => {
    const result = computeQuota({
      scans_used: 0,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 0,
        stripe_subscription_id: null, current_period_end: PAST,
      },
      now,
    });
    expect(result.is_paid).toBe(false);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA);
    expect(result.remaining).toBe(FREE_SCAN_QUOTA);
  });

  // CREDITS MUST SURVIVE EXPIRY. Migration 014 states scan_credits are bought
  // outright, cumulative and never expiring. Someone who bought a pack during
  // their comped month paid real money for those scans; losing the comp must
  // not take them. The fallback is FREE_SCAN_QUOTA + scan_credits, exactly as
  // it is for any other non-subscriber.
  it("keeps scan credits bought during the comped period", () => {
    const result = computeQuota({
      scans_used: 1,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 5,
        stripe_subscription_id: null, current_period_end: PAST,
      },
      now,
    });
    expect(result.is_paid).toBe(false);
    expect(result.total_quota).toBe(FREE_SCAN_QUOTA + 5);
    expect(result.remaining).toBe(FREE_SCAN_QUOTA + 5 - 1);
    expect(result.allowed).toBe(true);
    // Credits are reported separately so a surface can say "5 scans left"
    // without claiming they are on a plan -- and are now the only thing this
    // user has left.
    expect(result.credits_remaining).toBe(5);
  });

  it("keeps a comp on the Pro quota until its end date", () => {
    const result = computeQuota({
      scans_used: 0,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 0,
        stripe_subscription_id: null, current_period_end: FUTURE,
      },
      now,
    });
    expect(result.is_paid).toBe(true);
    expect(result.total_quota).toBe(200);
  });

  // EVERY COMP WRITTEN SO FAR IS NULL-DATED. Migration 009 added the column and
  // backfilled nothing, and a lifetime grant bills on no interval -- so NULL
  // means "never ends", not "ended". Expiring these would revoke the quota of
  // every comped account that exists today.
  it("leaves a comp with no end date perpetual", () => {
    const result = computeQuota({
      scans_used: 0,
      subscription: {
        status: "active", scan_quota: 100, scan_credits: 0,
        stripe_subscription_id: null, current_period_end: null,
      },
      now,
    });
    expect(result.is_paid).toBe(true);
    expect(result.total_quota).toBe(100);
  });

  // STRIPE ROWS ARE UNCHANGED BY THIS. current_period_end is refreshed by
  // invoice.paid; a late or retried webhook leaves it stale while the customer
  // is still being billed. Expiring on a date we might not have updated yet
  // would revoke paid access over our own bookkeeping lag, so a row with a
  // stripe_subscription_id is governed by status alone.
  it("never expires a real subscriber on a stale period end", () => {
    const result = computeQuota({
      scans_used: 10,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 0,
        stripe_subscription_id: STRIPE_SUB, current_period_end: PAST,
      },
      now,
    });
    expect(result.is_paid).toBe(true);
    expect(result.total_quota).toBe(200);
  });

  // `now` IS OPTIONAL, and defaults to this instant. Three production callers
  // pass an object literal and none of them has a reason to disagree about what
  // time it is; requiring it would be churn at every call site for no gained
  // safety. These two cases pin the default by omitting it.
  it("defaults to the current instant when no clock is supplied", () => {
    const longExpired = computeQuota({
      scans_used: 0,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 0,
        stripe_subscription_id: null,
        current_period_end: "2020-01-01T00:00:00.000Z",
      },
    });
    expect(longExpired.is_paid).toBe(false);
    expect(longExpired.total_quota).toBe(FREE_SCAN_QUOTA);

    const farFuture = computeQuota({
      scans_used: 0,
      subscription: {
        status: "active", scan_quota: 200, scan_credits: 0,
        stripe_subscription_id: null,
        current_period_end: "2099-01-01T00:00:00.000Z",
      },
    });
    expect(farFuture.is_paid).toBe(true);
    expect(farFuture.total_quota).toBe(200);
  });
});
