// What a paid subscription cost, and which ad bought it.
//
// The Stripe webhook already holds the price, the currency and the ad
// attribution when checkout.session.completed arrives - it just threw them
// away. Operations could not read the price from the DB side at all, and no
// paid subscription could be traced back to the click that produced it.
//
// These are source/schema contract tests, not live-Stripe tests: vitest runs
// environment "node" with no database, so the assertions pin (a) the migration
// shape, including the integer-cents unit decision, and (b) that the upsert in
// the checkout.session.completed handler actually writes the four values.
// End-to-end with a real Stripe signature stays the job of /verify.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { nullableAttributionValue } from "@/lib/attribution";

const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "008_subscription_price_attribution.sql",
);

const WEBHOOK_PATH = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "webhooks",
  "stripe",
  "route.ts",
);

const NEW_COLUMNS = ["price_cents", "currency", "gclid", "utm_campaign"] as const;

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8").toLowerCase();
}

// The upsert that runs for checkout.session.completed, isolated from the three
// other handlers in the file. Slicing it out means a match cannot be satisfied
// by an unrelated `.update({ ... })` in the renewal or cancellation branch.
/**
 * The upsert that records a completed SUBSCRIPTION checkout.
 *
 * Found by the status it writes, not by being the first upsert in the file.
 * A one-time scan pack also upserts this table -- deliberately without a
 * period, a cadence, or an active status -- and a positional search silently
 * began returning that block instead when packs were added, turning several
 * assertions here into checks on the wrong code.
 */
function checkoutSessionUpsertBlock(): string {
  const source = readFileSync(WEBHOOK_PATH, "utf8");
  let from = 0;
  for (;;) {
    const start = source.indexOf('.from("subscriptions").upsert(', from);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("onConflict", start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    if (block.includes('status: "active"')) return block;
    from = end;
  }
}

/**
 * The upsert that records a one-time scan pack purchase.
 *
 * Shares several contracts with the subscription block above -- a
 * server-validated amount, the currency Stripe reported, and the attribution
 * columns -- and deliberately shares none of the subscription-shaped ones.
 */
function scanPackUpsertBlock(): string {
  const source = readFileSync(WEBHOOK_PATH, "utf8");
  let from = 0;
  for (;;) {
    const start = source.indexOf('.from("subscriptions").upsert(', from);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("onConflict", start);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    if (block.includes("scan_credits")) return block;
    from = end;
  }
}

describe("008 migration: price and attribution columns on subscriptions", () => {
  it("exists at supabase/migrations/008_subscription_price_attribution.sql", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it.each([...NEW_COLUMNS])(
    "adds %s additively with `add column if not exists`",
    (column) => {
      expect(readMigration()).toContain("add column if not exists " + column);
    },
  );

  // The unit decision, pinned. pay_intent.price_cents (004) is already integer
  // cents; if this column drifted to numeric/decimal dollars the two tables
  // could not be summed in the same revenue query without a silent 100x error.
  it("declares price_cents as integer, so both money tables read in cents", () => {
    expect(readMigration()).toMatch(
      /add column if not exists price_cents\s+integer\b/,
    );
  });

  it("does not declare price_cents as numeric or decimal", () => {
    expect(readMigration()).not.toMatch(
      /add column if not exists price_cents\s+(numeric|decimal)/,
    );
  });

  it.each([...NEW_COLUMNS])("documents %s with a column comment", (column) => {
    expect(readMigration()).toContain(
      "comment on column public.subscriptions." + column,
    );
  });

  // Existing rows - comped accounts most of all - never went through Stripe.
  // NULL is the correct value for a lifetime grant with no purchase attached,
  // so nothing here may be NOT NULL or carry a backfilling default.
  it("keeps every new column nullable with no default", () => {
    const declarations = readMigration()
      .split("\n")
      .filter((line) => line.includes("add column if not exists"));
    expect(declarations).toHaveLength(NEW_COLUMNS.length);
    for (const declaration of declarations) {
      expect(declaration).not.toContain("not null");
      expect(declaration).not.toContain("default");
    }
  });
});

describe("stripe webhook: persists price, currency and ad attribution", () => {
  it("writes price_cents into the subscriptions upsert", () => {
    expect(checkoutSessionUpsertBlock()).toContain("price_cents:");
  });

  // planAmount is already computed above the upsert for the
  // subscription_activated analytics event. Recomputing it would create a
  // second source of truth that could disagree with the reported revenue.
  it("reuses the already-computed planAmount rather than recomputing", () => {
    expect(checkoutSessionUpsertBlock()).toContain("price_cents: planAmount");
  });

  it("writes currency into the subscriptions upsert", () => {
    expect(checkoutSessionUpsertBlock()).toContain("currency:");
  });

  // Stripe reports the lowercase ISO-4217 code it actually charged in. Reading
  // it keeps the stored amount unambiguous; a hardcoded "usd" would keep
  // claiming usd even if the charge were ever denominated differently.
  it("reads the currency Stripe reported rather than hardcoding a literal", () => {
    expect(checkoutSessionUpsertBlock()).toContain("session.currency");
  });

  it.each(["gclid", "utm_campaign"])(
    "writes %s into the subscriptions upsert",
    (column) => {
      expect(checkoutSessionUpsertBlock()).toContain(column + ":");
    },
  );

  // The checkout route writes "" for absent attribution (it builds a Stripe
  // metadata bag, which cannot hold null). Persisting that empty string would
  // make "no attribution" invisible to `where gclid is null`.
  it("normalises the attribution metadata instead of storing it raw", () => {
    const block = checkoutSessionUpsertBlock();
    expect(block).toContain("nullableAttributionValue(");
    expect(block).not.toMatch(/gclid:\s*session\.metadata/);
    expect(block).not.toMatch(/utm_campaign:\s*session\.metadata/);
  });

  it("leaves the other three handlers alone", () => {
    const source = readFileSync(WEBHOOK_PATH, "utf8");
    const others = source.slice(source.indexOf("customer.subscription.deleted"));
    expect(others).not.toContain("price_cents");
    expect(others).not.toContain("utm_campaign");
  });
});

// The normalisation itself, tested directly. It lives in src/lib/attribution.ts
// next to resolvePayIntentAttribution (which produced these values in the first
// place) rather than inside route.ts, because a Next.js App Router route file
// may only export route handlers and segment config.
describe("nullableAttributionValue: empty metadata becomes NULL", () => {
  it.each([
    ["an empty string", ""],
    ["a whitespace-only string", "   "],
    ["undefined", undefined],
    ["null", null],
  ])("maps %s to null", (_label, input) => {
    expect(nullableAttributionValue(input)).toBeNull();
  });

  it("returns a real gclid unchanged", () => {
    expect(nullableAttributionValue("Cj0KCQjw_abc123")).toBe("Cj0KCQjw_abc123");
  });

  it("returns a real campaign name unchanged", () => {
    expect(nullableAttributionValue("fraudshield-phase3")).toBe(
      "fraudshield-phase3",
    );
  });

  it("trims surrounding whitespace so the stored value is queryable", () => {
    expect(nullableAttributionValue("  brand-terms  ")).toBe("brand-terms");
  });

  it("never returns an empty string", () => {
    for (const input of ["", " ", "\t", "\n", undefined, null]) {
      expect(nullableAttributionValue(input)).not.toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// The one-time pack purchase records the same money facts.
//
// Packs were added after a week of live checkout in which 8 ad visitors opened
// Stripe and none paid. They write to the same table and must not quietly keep
// a lower standard of record than a subscription does.
// ---------------------------------------------------------------------------

describe("a scan pack purchase records the same money facts", () => {
  it("writes the server-validated amount, not Stripe's final total", () => {
    const block = scanPackUpsertBlock();
    expect(block).toContain("price_cents: planAmount");
    expect(block).not.toContain("amount_total");
  });

  it("reads the currency Stripe reported rather than hardcoding a literal", () => {
    expect(scanPackUpsertBlock()).toContain("session.currency");
  });

  it.each(["gclid", "utm_campaign", "email_sha256"])(
    "writes %s so a pack sale is attributable too",
    (column) => {
      expect(scanPackUpsertBlock()).toContain(column + ":");
    },
  );

  // THE LINE THAT MUST NOT MOVE. Marking a pack buyer active would hand them
  // the Pro monthly quota, hide the upgrade CTA, and make their next purchase
  // fail with already_subscribed.
  it("never marks a pack buyer as an active subscriber", () => {
    expect(scanPackUpsertBlock()).not.toContain('status: "active"');
  });

  // A pack has no cadence and no period. Recording either would describe a
  // renewal that is never going to happen.
  it.each(["billing_interval", "current_period_start", "current_period_end"])(
    "does not invent %s for a purchase that never renews",
    (column) => {
      expect(scanPackUpsertBlock()).not.toContain(column + ":");
    },
  );
});
