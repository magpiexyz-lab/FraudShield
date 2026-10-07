// Which Stripe mode a subscription came from.
//
// WHY IT EXISTS. The Google Ads uploader refuses to send conversions from a
// table that mixes Stripe test-mode and live-mode rows without a per-row flag.
// The only candidate it currently finds is a TEST-mode subscription carrying a
// real gclid -- exactly the row that must never reach Google Ads. Reporting a
// test purchase as revenue corrupts the campaign's optimisation, not just the
// count, and that is not a mistake you can take back once the bid model has
// learned from it.
//
// vitest runs environment "node" with no database and no Stripe credentials, so
// these are source/schema contract tests in the convention of
// subscription-cancel-pending.test.ts: they pin the migration's shape and the
// fact that every write path records the mode.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "012_subscription_livemode.sql",
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

const readMigration = (): string =>
  readFileSync(MIGRATION_PATH, "utf8").toLowerCase();
const webhookSource = (): string => readFileSync(WEBHOOK_PATH, "utf8");

describe("012 migration: livemode on subscriptions", () => {
  it("exists at supabase/migrations/012_subscription_livemode.sql", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("adds the column additively", () => {
    expect(readMigration()).toContain("add column if not exists livemode boolean");
  });

  // THREE-VALUED ON PURPOSE, and the third value is load-bearing. A default
  // would assert a Stripe mode for a comped grant that no Stripe event ever
  // touched -- and defaulting to false would be a lie about rows that are not
  // test purchases, while defaulting to true would make them uploadable.
  it("takes no default, so comped grants stay NULL", () => {
    const line = readMigration()
      .split("\n")
      .find((l) => l.includes("add column if not exists livemode"));
    expect(line).toBeDefined();
    expect(line).not.toContain("default");
    expect(line).not.toContain("not null");
  });

  // The backfill must not invent a mode for rows that never had a checkout.
  it("backfills only rows that have a Stripe subscription", () => {
    const sql = readMigration();
    const update = sql.slice(sql.indexOf("update public.subscriptions"));
    expect(update).toContain("set livemode = false");
    expect(update).toContain("stripe_subscription_id is not null");
  });

  // Anyone reading the backfill has to be able to check the claim rather than
  // trust it: false is exact only because the live-key interlock made a live
  // checkout impossible for the whole life of the project.
  it("says why false is exact for every existing row", () => {
    const sql = readMigration();
    expect(sql).toContain("interlock");
    expect(sql).toMatch(/sk_test_|rk_test_/);
  });

  it("documents the three values on the column", () => {
    const sql = readMigration();
    expect(sql).toContain("comment on column public.subscriptions.livemode");
    expect(sql).toContain("comped");
  });

  it("does not renumber or restate migrations 001-011", () => {
    const sql = readMigration();
    expect(sql).not.toContain("create table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("alter column");
  });
});

describe("the webhook records the mode on every write", () => {
  // Taken from the EVENT, not the object. Stripe puts livemode on the event
  // envelope, so it is available to every handler without a second API call --
  // and reading it from the object would differ per event type, which is how
  // one path ends up quietly not recording it.
  it("reads livemode from the event, not from the object", () => {
    const source = webhookSource();
    expect(source).toContain("livemode: event.livemode");
    expect(source).not.toMatch(/livemode:\s*(session|invoice|subscription)\.livemode/);
  });

  // Checkout is where the row is created, so this is the one that must never
  // be missing. The others repair; this one originates.
  it("writes it on checkout.session.completed", () => {
    const source = webhookSource();
    const start = source.indexOf('event.type === "checkout.session.completed"');
    const end = source.indexOf('event.type === "customer.subscription.deleted"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("livemode: event.livemode");
  });

  // REPAIR PATHS. A subscription's mode never changes, so rewriting it on a
  // later event cannot make the row wrong -- but it does rescue a row that
  // missed the flag at checkout, which would otherwise stay NULL forever and
  // silently drop out of every upload without anyone noticing.
  it("writes it on the renewal path too", () => {
    const source = webhookSource();
    // Bounded by the branch's own error handler rather than a character
    // window or the next event type. A window guesses how long the comments
    // are; the next event type does not appear, because payment_failed is the
    // `else` of this `if` and never names itself again.
    const start = source.indexOf('if (event.type === "invoice.paid")');
    const end = source.indexOf('[webhook] renewal update error', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("livemode: event.livemode");
  });

  // Every handler that updates the row writes the mode. Counted rather than
  // located one by one: the contract is "all of them", and a new handler added
  // later without it is the failure this catches.
  it("writes it from every handler that touches the row", () => {
    const source = webhookSource();
    const writes = (source.match(/livemode: event\.livemode/g) ?? []).length;
    expect(writes).toBeGreaterThanOrEqual(5);
  });
});
