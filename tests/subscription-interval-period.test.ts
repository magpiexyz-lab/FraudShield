// The recurring interval, and the END of the current billing period.
//
// public.subscriptions could already answer "how much, in what currency, what
// status, when did the period start" (001, 007, 008) - but not "how often is
// this billed" and not "when does the current period end". Both were asked for
// by name, and neither was derivable from the row: the interval lived only in
// the Stripe dashboard Price, and the period end only on the Stripe
// Subscription. 009_subscription_interval_period_end.sql adds the pair.
//
// These are source/schema contract tests, not live-Stripe tests: vitest runs
// environment "node" with no database and no Stripe credentials, so the
// assertions pin (a) the migration shape, including the deliberate
// billing_interval naming, and (b) that the webhook actually writes both
// values at purchase and refreshes the period end on renewal. End-to-end with
// a real Stripe signature stays the job of /verify.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "009_subscription_interval_period_end.sql",
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

const CHECKOUT_PATH = path.join(
  repoRoot,
  "src",
  "app",
  "api",
  "checkout",
  "route.ts",
);

const NEW_COLUMNS = ["billing_interval", "current_period_end"] as const;

function readMigration(): string {
  return readFileSync(MIGRATION_PATH, "utf8").toLowerCase();
}

// The upsert that runs for checkout.session.completed, isolated from the three
// other handlers in the file. Slicing it out means a match cannot be satisfied
// by an unrelated .update() in the renewal or cancellation branch.
function checkoutSessionUpsertBlock(): string {
  const source = readFileSync(WEBHOOK_PATH, "utf8");
  const start = source.indexOf('.from("subscriptions").upsert(');
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("onConflict", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

// The invoice.paid renewal update, isolated from the invoice.payment_failed
// branch that follows it in the same handler.
function renewalUpdateBlock(): string {
  const source = readFileSync(WEBHOOK_PATH, "utf8");
  const start = source.indexOf(
    'status: "active",',
    source.indexOf("invoice.paid"),
  );
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("renewErr", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("009 migration: billing interval and period end on subscriptions", () => {
  it("exists at supabase/migrations/009_subscription_interval_period_end.sql", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it.each([...NEW_COLUMNS])(
    "adds %s additively with add-column-if-not-exists",
    (column) => {
      expect(readMigration()).toContain("add column if not exists " + column);
    },
  );

  // NAMING, pinned. interval is a reserved type name in PostgreSQL; a bare
  // column of that name forces every downstream query to double-quote it and
  // silently breaks the ones that forget. billing_interval needs no quoting.
  it("names the interval column billing_interval", () => {
    expect(readMigration()).toMatch(
      /add column if not exists billing_interval\s+text\b/,
    );
  });

  it("never declares a bare column named interval", () => {
    const sql = readMigration();
    expect(sql).not.toMatch(/add column if not exists "?interval"?[\s,]/);
    expect(sql).not.toMatch(
      /comment on column public\.subscriptions\."?interval"?\s/,
    );
  });

  // current_period_start (007) is timestamptz. If its partner landed as a bare
  // timestamp the pair would compare across an implicit timezone assumption.
  it("declares current_period_end as timestamptz, like current_period_start", () => {
    expect(readMigration()).toMatch(
      /add column if not exists current_period_end\s+timestamptz\b/,
    );
  });

  it.each([...NEW_COLUMNS])("documents %s with a column comment", (column) => {
    expect(readMigration()).toContain(
      "comment on column public.subscriptions." + column,
    );
  });

  // Rows written before this migration never had these values, and comped
  // accounts have no Stripe subscription behind them at all. NULL is the
  // truthful value for both, so nothing here may be NOT NULL or backfilled.
  it("keeps both new columns nullable with no default", () => {
    const declarations = readMigration()
      .split("\n")
      .filter((line) => line.includes("add column if not exists"));
    expect(declarations).toHaveLength(NEW_COLUMNS.length);
    for (const declaration of declarations) {
      expect(declaration).not.toContain("not null");
      expect(declaration).not.toContain("default");
    }
  });

  // The column records what was billed; it does not enforce it. The binding
  // check is the Price validation in the checkout route. Say so in the file so
  // a reader cannot mistake a descriptive column for a constraint.
  it("records that billing_interval is descriptive, not authoritative", () => {
    const sql = readMigration();
    expect(sql).toContain("src/app/api/checkout/route.ts");
    expect(sql).toMatch(/descriptive|not authoritative|does not enforce/);
  });

  it("does not renumber or restate migrations 001-008", () => {
    expect(readMigration()).not.toContain("create table");
    expect(readMigration()).not.toContain("drop column");
  });
});

describe("stripe webhook: persists interval and period end at purchase", () => {
  it.each([...NEW_COLUMNS])(
    "writes %s into the checkout.session.completed upsert",
    (column) => {
      expect(checkoutSessionUpsertBlock()).toContain(column + ":");
    },
  );

  // The interval rides the metadata bag the checkout route already stamps onto
  // both the Session and the Subscription. Reading it there keeps the value
  // server-validated and costs no extra Stripe round-trip.
  it("sources billing_interval from the server-written session metadata", () => {
    expect(checkoutSessionUpsertBlock()).toMatch(/billing_interval:\s*\w/);
    expect(readFileSync(WEBHOOK_PATH, "utf8")).toContain(
      "session.metadata?.billing_interval",
    );
  });

  // current_period_end is NOT on the Session, so it has to be retrieved. In
  // Stripe SDK 22.2.0 it is not top-level on Subscription either - it lives on
  // the subscription items (see the NOTE in the webhook).
  it("retrieves the Subscription to obtain the period end", () => {
    const source = readFileSync(WEBHOOK_PATH, "utf8");
    expect(source).toContain("subscriptions.retrieve");
    expect(source).toContain("current_period_end");
  });

  // A missing end date must never block activating a paid subscription: the
  // user has been charged. Failure writes NULL and logs.
  it("tolerates a failed retrieve instead of failing the webhook", () => {
    const source = readFileSync(WEBHOOK_PATH, "utf8");
    const start = source.indexOf("subscriptions.retrieve");
    const region = source.slice(Math.max(0, start - 1200), start + 1200);
    expect(region).toContain("catch");
    expect(region).toMatch(/console\.(error|warn)/);
  });

  it("stores the period end as an ISO string, not a raw Unix timestamp", () => {
    expect(readFileSync(WEBHOOK_PATH, "utf8")).toContain("toISOString()");
    expect(checkoutSessionUpsertBlock()).not.toMatch(
      /current_period_end:\s*\w+\.current_period_end\b/,
    );
  });
});

describe("stripe webhook: keeps the period pair in step on renewal", () => {
  // current_period_start already rolls forward on invoice.paid. If its partner
  // did not, the two would drift apart from month two onward and the row would
  // describe a period that ended before it started.
  it("refreshes current_period_end in the invoice.paid update", () => {
    expect(renewalUpdateBlock()).toContain("current_period_end:");
  });

  it("still rolls current_period_start forward", () => {
    expect(renewalUpdateBlock()).toContain("current_period_start:");
  });

  // The interval does not change when an existing subscription renews, so
  // rewriting it on renewal would only add a way for it to be wrong.
  it("leaves billing_interval untouched on renewal", () => {
    expect(renewalUpdateBlock()).not.toContain("billing_interval");
  });
});

describe("checkout route: puts the validated interval in the metadata bag", () => {
  it("adds the interval to the metadata object", () => {
    const source = readFileSync(CHECKOUT_PATH, "utf8");
    const start = source.indexOf("const metadata = {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("};", start);
    expect(source.slice(start, end)).toContain("billing_interval");
  });

  // The interval must come from the Price that Stripe will actually bill, the
  // same object the mismatch guard checks - not from a hardcoded "month" that
  // would keep claiming monthly no matter what the Price said.
  it("derives the interval from the retrieved Stripe Price", () => {
    const source = readFileSync(CHECKOUT_PATH, "utf8");
    expect(source).toMatch(/billingInterval\s*=\s*price\.recurring/);
  });

  // Regression guard: this PR must not weaken the interlock that keeps the
  // route incapable of taking real money before the cancellation path ships.
  it("keeps the live-key safety interlock intact", () => {
    const source = readFileSync(CHECKOUT_PATH, "utf8");
    expect(source).toContain("liveKeyInterlock");
    expect(source).toContain('stripeKey.startsWith("sk_test_")');
    expect(source).toContain('stripeKey.startsWith("rk_test_")');
  });
});
