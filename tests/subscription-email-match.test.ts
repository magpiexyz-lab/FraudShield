// A fallback join key for the Google Ads conversion upload.
//
// gclid (008) is the precise link from a sale to the click that bought it, and
// the fragile one: ad blockers, stripped query strings and purchases made days
// later in another browser all arrive without it. Those sales are real revenue
// the upload cannot attribute, so the campaign measures worse than it performed.
// The email hash is what matches them.
//
// The hashing itself is tested behaviourally in src/lib/email-hash.test.ts,
// against real inputs. What is pinned HERE is the part that behaviour test
// cannot see: the migration's shape, and -- the load-bearing one -- WHICH email
// gets hashed. vitest runs environment "node" with no database and no Stripe
// credentials, so these are source/schema contracts.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "011_subscription_email_match.sql",
);

const CHECKOUT_PATH = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "checkout",
  "route.ts",
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
const checkoutSource = (): string => readFileSync(CHECKOUT_PATH, "utf8");
const webhookSource = (): string => readFileSync(WEBHOOK_PATH, "utf8");

describe("011 migration: email_sha256 on subscriptions", () => {
  it("exists at supabase/migrations/011_subscription_email_match.sql", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("adds the column additively", () => {
    expect(readMigration()).toContain(
      "add column if not exists email_sha256",
    );
  });

  // NULLABLE AND UNDEFAULTED, both load-bearing. sha256('') is a real constant
  // digest, so a default would stamp one identical value onto every row that
  // had no email and then join all of those customers to each other -- a wrong
  // answer that looks like a right one. NULL means "not known".
  it("leaves the column nullable with no default", () => {
    const sql = readMigration();
    const line = sql
      .split("\n")
      .find((l) => l.includes("add column if not exists email_sha256"));
    expect(line).toBeDefined();
    expect(line).not.toContain("not null");
    expect(line).not.toContain("default");
  });

  // Shape constraint, not a correctness one: a database cannot check that a
  // digest was taken over a properly normalised input. What it CAN reject is a
  // raw email address written into the column by a future code path, and an
  // upper-case digest -- hex compares case-sensitively, so 'AB..' and 'ab..'
  // would silently be two keys for one customer.
  it("constrains the value to 64 lowercase hex characters or NULL", () => {
    const sql = readMigration();
    expect(sql).toMatch(/check\s*\(/);
    expect(sql).toContain("[0-9a-f]{64}");
    expect(sql).toContain("is null or");
  });

  it("indexes the column for the upload's lookup", () => {
    expect(readMigration()).toContain("create index if not exists");
  });

  it("documents the column", () => {
    expect(readMigration()).toContain(
      "comment on column public.subscriptions.email_sha256",
    );
  });

  it("does not renumber or restate migrations 001-010", () => {
    const sql = readMigration();
    expect(sql).not.toContain("create table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("alter column");
  });
});

describe("email_sha256 is derived from the authenticated email", () => {
  // THE SECURITY PROPERTY, and the reason this hash is computed in the checkout
  // route rather than the webhook. `user.email` comes from the Supabase session
  // cookie. `session.customer_email` does not -- the webhook's own header warns
  // it is attacker-controllable, and hashing THAT would let a buyer type any
  // address at checkout and have their purchase credited to that person's ad
  // click. The conversion upload would then attribute revenue to whichever
  // campaign the buyer chose.
  it("hashes the authenticated user's email", () => {
    expect(checkoutSource()).toContain("hashEmailForMatching(user.email)");
  });

  it("never hashes a Stripe- or client-supplied address", () => {
    for (const source of [checkoutSource(), webhookSource()]) {
      expect(source).not.toMatch(/hashEmailForMatching\(\s*session/);
      expect(source).not.toMatch(/hashEmailForMatching\(\s*body/);
      expect(source).not.toMatch(/hashEmailForMatching\([^)]*customer_email/);
    }
  });

  // The webhook must persist what it was given, not recompute. If it hashed
  // anything itself it could only be reaching for an untrusted field, since the
  // trustworthy one is not on the Subscription object at all.
  it("does not hash anything in the webhook", () => {
    expect(webhookSource()).not.toContain("hashEmailForMatching");
  });

  // Stripe metadata cannot hold null, so the absent case travels as "" and is
  // mapped back by the same helper gclid and utm_campaign already use. Writing
  // "" into the column would violate the check constraint and fail the upsert
  // for a customer who has already been charged.
  it("normalises the empty metadata value back to NULL on write", () => {
    expect(webhookSource()).toContain(
      "email_sha256: nullableAttributionValue(session.metadata?.email_sha256)",
    );
  });

  it("sends an empty string rather than null through metadata", () => {
    expect(checkoutSource()).toMatch(
      /email_sha256:\s*hashEmailForMatching\(user\.email\)\s*\?\?\s*""/,
    );
  });
});
