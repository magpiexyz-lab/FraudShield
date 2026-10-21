// Scans bought outright, without a subscription.
//
// WHY THEY EXIST. A week of live checkout produced 8 real visitors from the ads
// who opened Stripe and none who paid; the one who came back and said why said
// the reason was price. Intent was never the problem -- more than half of the
// people who reach the paywall click through to checkout -- so what changed is
// the size of the commitment at the end, not the funnel in front of it.
//
// The quota arithmetic is exercised for real against computeQuota. The rest are
// source contracts: vitest runs environment "node" with no database, no Stripe
// and no jsdom.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { computeQuota } from "@/lib/quota";
import { SCAN_PACKS, scanPackById, FREE_SCAN_QUOTA } from "@/lib/types";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const MIGRATION = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "014_scan_credits.sql",
);
const migrationSql = () => readFileSync(MIGRATION, "utf8").toLowerCase();

const CHECKOUT = read("src", "app", "api", "checkout", "route.ts");
const WEBHOOK = read("src", "app", "api", "webhooks", "stripe", "route.ts");
const COMPONENT = read("src", "components", "scan-pack-options.tsx");
const PRICING = read("src", "app", "pricing", "pricing-plans.tsx");
const SCAN_RESULT = read("src", "app", "scan-result", "scan-result-client.tsx");

/**
 * The pack-grant branch of the webhook, bounded by the subscription path and
 * stripped of comments.
 *
 * Comments are removed because the assertions below are about what the code
 * does, and this block's own prose explains why it does NOT fire
 * subscription_activated -- which read as the very thing being forbidden.
 */
function packGrantBlock(): string {
  const start = WEBHOOK.indexOf("if (pack) {");
  expect(start).toBeGreaterThan(-1);
  const end = WEBHOOK.indexOf("const planQuota", start);
  expect(end).toBeGreaterThan(start);
  const NL = String.fromCharCode(10);
  return WEBHOOK.slice(start, end)
    .split(NL)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join(NL);
}

/** A billing row for someone who has never subscribed. */
const unsubscribed = (credits: number) => ({
  status: "inactive" as const,
  scan_quota: 0,
  scan_credits: credits,
});

describe("the catalogue", () => {
  it("offers a single scan and a pack, both priced in cents", () => {
    expect(SCAN_PACKS.map((p) => p.id)).toEqual(["scan_1", "scan_5"]);
    for (const pack of SCAN_PACKS) {
      expect(Number.isInteger(pack.price_cents)).toBe(true);
      expect(pack.price_cents).toBeGreaterThan(0);
      expect(pack.scans).toBeGreaterThan(0);
    }
  });

  // The pack has to be worth buying over the single, or it is not an offer.
  it("prices the pack below the per-scan rate of a single", () => {
    const single = SCAN_PACKS[0];
    const pack = SCAN_PACKS[1];
    expect(pack.price_cents / pack.scans).toBeLessThan(single.price_cents);
  });

  // The id travels through Stripe metadata and comes back on the webhook. An
  // id that does not round-trip grants nothing.
  it("resolves a pack from the id that travels through checkout", () => {
    expect(scanPackById("scan_5")?.scans).toBe(5);
    expect(scanPackById("pro")).toBeNull();
    expect(scanPackById(null)).toBeNull();
    expect(scanPackById("")).toBeNull();
  });
});

describe("credits in the quota arithmetic", () => {
  it("adds bought scans to the free allowance", () => {
    const q = computeQuota({ scans_used: 0, subscription: unsubscribed(5) });
    expect(q.total_quota).toBe(FREE_SCAN_QUOTA + 5);
    expect(q.allowed).toBe(true);
  });

  it("still allows a scan once the free one is spent", () => {
    const q = computeQuota({ scans_used: 1, subscription: unsubscribed(5) });
    expect(q.allowed).toBe(true);
    expect(q.remaining).toBe(5);
  });

  it("stops when the bought scans run out", () => {
    const q = computeQuota({ scans_used: 6, subscription: unsubscribed(5) });
    expect(q.allowed).toBe(false);
    expect(q.remaining).toBe(0);
  });

  // Reported separately so a surface can say "4 left" without claiming the
  // person is on a plan -- and bounded by what is actually left, since someone
  // who bought 5 and has 2 remaining has 2 paid scans, not 5.
  it("reports paid scans remaining, never more than remain", () => {
    expect(
      computeQuota({ scans_used: 4, subscription: unsubscribed(5) })
        .credits_remaining,
    ).toBe(2);
  });

  // A SUBSCRIBER ALLOWANCE IS MONTHLY; CREDITS ARE PERMANENT. scans_used is
  // reckoned from the billing period for a subscriber and all-time for everyone
  // else, so adding the two would compare quantities measured against different
  // clocks and hand out extra scans every month forever.
  it("never adds credits to a subscriber monthly quota", () => {
    const q = computeQuota({
      scans_used: 0,
      subscription: { status: "active", scan_quota: 200, scan_credits: 5 },
    });
    expect(q.total_quota).toBe(200);
    expect(q.credits_remaining).toBe(0);
  });

  it("treats a user with no billing row as free tier", () => {
    const q = computeQuota({ scans_used: 0, subscription: null });
    expect(q.total_quota).toBe(FREE_SCAN_QUOTA);
    expect(q.credits_remaining).toBe(0);
  });
});

describe("014 migration", () => {
  it("exists and adds the column additively", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(migrationSql()).toContain(
      "add column if not exists scan_credits integer",
    );
  });

  // NOT NULL DEFAULT 0, unlike the nullable Stripe columns in 007-013. Those
  // record facts about an event that may not have happened; this is a count,
  // and the honest value for someone who has bought nothing is zero.
  it("defaults to zero rather than null", () => {
    expect(migrationSql()).toContain("not null default 0");
  });

  it("refuses a negative grant", () => {
    expect(migrationSql()).toContain("check (scan_credits >= 0)");
  });

  it("does not renumber or restate earlier migrations", () => {
    expect(migrationSql()).not.toContain("create table");
    expect(migrationSql()).not.toContain("drop column");
  });
});

describe("checkout opens the right kind of Stripe session", () => {
  // A pack bought in subscription mode would bill every month forever.
  it("uses payment mode for a pack and subscription mode otherwise", () => {
    expect(CHECKOUT).toContain('mode: pack ? "payment" : "subscription"');
  });

  // Stripe rejects subscription_data in payment mode outright.
  it("omits subscription_data for a pack", () => {
    expect(CHECKOUT).toContain("...(pack ? {} : { subscription_data:");
  });

  // THE EXPENSIVE MISTAKE. A pack pointed at a recurring Price would sign
  // someone up to pay for one scan every month.
  it("refuses a recurring Price for a pack", () => {
    expect(CHECKOUT).toContain('price.type !== "one_time"');
    expect(CHECKOUT).toContain("price.recurring != null");
  });

  it("still refuses a one-time Price for the subscription", () => {
    expect(CHECKOUT).toContain('price.type !== "recurring"');
  });

  // The client never sends a price -- the slug is validated against a closed
  // enum and the amount comes from the server catalogue.
  it("takes the amount from the catalogue, not the request", () => {
    expect(CHECKOUT).toContain("pack ? pack.price_cents : PLAN_PRICES[plan]");
  });
});

describe("the webhook grants what was bought", () => {
  it("adds to any credits already held rather than overwriting", () => {
    expect(packGrantBlock()).toContain("current + pack.scans");
  });

  // Marking a pack buyer active would hand them the Pro monthly quota, hide
  // the upgrade CTA, and make their next purchase fail already_subscribed.
  it("does not make a pack buyer look like a subscriber", () => {
    expect(packGrantBlock()).not.toContain('status: "active"');
  });

  // subscription_activated is read literally as the paid SUBSCRIPTION funnel.
  it("reports a purchase without inflating subscriber counts", () => {
    expect(packGrantBlock()).toContain('trackServerEvent("one_time_purchase"');
    expect(packGrantBlock()).not.toContain("subscription_activated");
  });

  it("declares the event in EVENTS.yaml", () => {
    expect(read("experiment", "EVENTS.yaml")).toContain("one_time_purchase:");
  });
});

describe("where the offer appears", () => {
  it("is offered on the pricing page and the scan-result paywall", () => {
    expect(PRICING).toContain('<ScanPackOptions surface="pricing"');
    expect(SCAN_RESULT).toContain('<ScanPackOptions surface="scan_result"');
  });

  // One component, two surfaces. Two copies of a money button would drift.
  it("uses one implementation for both", () => {
    expect(PRICING).toContain('from "@/components/scan-pack-options"');
    expect(SCAN_RESULT).toContain('from "@/components/scan-pack-options"');
  });

  // Selling scans to someone who already has 200 a month is not an offer.
  it("is hidden from subscribers on the pricing page", () => {
    expect(PRICING).toContain("onUpgrade && !subscribed && !notConfigured");
  });

  // Double-click protection: two sessions would be opened and the second
  // abandoned by construction.
  it("cannot open two checkout sessions at once", () => {
    expect(COMPONENT).toContain("firedRef.current");
  });

  // The promise made on the button has to match the migration behaviour.
  it("says the scans do not expire, which the schema guarantees", () => {
    expect(COMPONENT).toContain("never expire");
    expect(migrationSql()).toContain("do not expire");
  });
});
