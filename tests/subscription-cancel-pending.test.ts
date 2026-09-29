// Cancellation reported when the CUSTOMER CANCELS, not a month later.
//
// PRODUCTION BUG this pins. A real cancellation was taken through the Stripe
// billing portal on the live site. Stripe emitted TWO
// customer.subscription.updated events and NO customer.subscription.deleted,
// because portal cancellation schedules the end and leaves the subscription
// ACTIVE until the paid month runs out -- .deleted only arrives when the
// period actually elapses, up to 30 days later. The webhook handled
// .deleted only, so nothing fired and nothing was recorded:
// subscription_canceled never reached PostHog, and the row stayed
// status=active with no trace that the customer had already left.
//
// Consequences that make this a correctness bug and not a nicety: the fleet
// readiness check looks for subscription_canceled on a test-card pass and saw
// nothing; churn analytics lagged by a full billing period; and the product
// could not tell a happy subscriber from one who had already gone.
//
// SECOND PRODUCTION BUG this pins, found because the first fix did not work.
// The .updated branch shipped and still reported nothing. The captured event
// (evt_1UKuEJRamJuooj63TxSnsho6, API version 2026-07-29.dahlia) showed why:
// the portal sets `cancel_at` to the period end and leaves
// `cancel_at_period_end` FALSE. The handler tested the false field.
//
// The test suite could not have caught that, because it asserted the handler's
// SOURCE TEXT -- it grepped for `subscription.cancel_at_period_end` and passed
// when it found it. It pinned the defect instead of detecting it. A test that
// checks which field the code names can only ever confirm the author's
// assumption; the fix is to run the decision against a payload Stripe really
// sent, which is what the last describe block in this file now does.
//
// The remaining assertions are source/schema contract tests, matching the
// convention of tests/subscription-interval-period.test.ts: vitest runs
// environment "node" with no database and no Stripe credentials, so they pin
// (a) the migration shape and (b) the branch structure of the webhook.
// End-to-end with a real Stripe signature stays the job of /verify.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isPendingCancellation } from "@/lib/stripe-cancel";

const repoRoot = path.resolve(__dirname, "..");

const MIGRATION_PATH = path.join(
  repoRoot,
  "supabase",
  "migrations",
  "010_subscription_cancel_pending.sql",
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

// cancel_at_period_end is the PENDING FLAG and the idempotency key;
// canceled_at is the record of WHEN the customer decided to leave. See the
// migration header for why both exist and why neither alone is sufficient.
const NEW_COLUMNS = ["cancel_at_period_end", "canceled_at"] as const;

const UPDATED_GUARD = "event.type === \"customer.subscription.updated\"";
const DELETED_GUARD = "event.type === \"customer.subscription.deleted\"";
const CANCEL_EVENT = "trackServerEvent(\"subscription_canceled\"";

const webhookSource = (): string => readFileSync(WEBHOOK_PATH, "utf8");

const readMigration = (): string =>
  readFileSync(MIGRATION_PATH, "utf8").toLowerCase();

// The customer.subscription.updated handler, sliced out so that no assertion
// can be satisfied by the .deleted handler or by the invoice branches next
// door.
const updatedHandlerBlock = (): string => {
  const source = webhookSource();
  const start = source.indexOf(UPDATED_GUARD);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("event.type === \"invoice.paid\"", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

// The pre-existing customer.subscription.deleted handler, sliced out the same
// way. Regression surface: this change must not weaken the signal for access
// actually ending.
const deletedHandlerBlock = (): string => {
  const source = webhookSource();
  const start = source.indexOf(DELETED_GUARD);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(UPDATED_GUARD, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("010 migration: pending cancellation on subscriptions", () => {
  it("exists at supabase/migrations/010_subscription_cancel_pending.sql", () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
  });

  it.each([...NEW_COLUMNS])(
    "adds %s additively with add-column-if-not-exists",
    (column) => {
      expect(readMigration()).toContain("add column if not exists " + column);
    },
  );

  // TWO-VALUED ON PURPOSE. This column is read as the idempotency guard, so a
  // third "unknown" state would be a correctness hazard: "not
  // cancel_at_period_end" evaluates to NULL for a NULL row, which would make
  // every pre-existing row invisible to the guard. There is no such thing as
  // not knowing whether we have recorded a pending cancellation.
  it("declares cancel_at_period_end as a boolean defaulting to false", () => {
    expect(readMigration()).toMatch(
      /add column if not exists cancel_at_period_end\s+boolean[^,;]*default\s+false/,
    );
  });

  it("makes cancel_at_period_end not null so the guard is two-valued", () => {
    expect(readMigration()).toMatch(
      /add column if not exists cancel_at_period_end\s+boolean[^,;]*not null/,
    );
  });

  // Partner of current_period_start (007) and current_period_end (009), which
  // are both timestamptz. A bare timestamp would compare against them across
  // an implicit timezone assumption.
  it("declares canceled_at as a nullable timestamptz", () => {
    const sql = readMigration();
    expect(sql).toMatch(/add column if not exists canceled_at\s+timestamptz/);
    const declaration = sql
      .split("\n")
      .find((line) => line.includes("add column if not exists canceled_at"));
    expect(declaration).toBeDefined();
    expect(declaration).not.toContain("not null");
  });

  it.each([...NEW_COLUMNS])("documents %s with a column comment", (column) => {
    expect(readMigration()).toContain(
      "comment on column public.subscriptions." + column,
    );
  });

  // The header has to say WHY the pair exists and what the empty state means,
  // or the next reader collapses them back into one column.
  it("explains why the columns exist and what false and NULL mean", () => {
    const sql = readMigration();
    expect(sql).toContain("cancel_at_period_end");
    expect(sql).toMatch(/idempoten/);
    expect(sql).toMatch(/null/);
  });

  // The whole point is that access is NOT revoked on a pending cancellation.
  // Say so in the migration, next to the column that records it.
  it("records that a pending cancellation does not end access", () => {
    expect(readMigration()).toMatch(/access/);
  });

  it("does not renumber or restate migrations 001-009", () => {
    const sql = readMigration();
    expect(sql).not.toContain("create table");
    expect(sql).not.toContain("drop column");
    expect(sql).not.toContain("alter column");
  });
});

describe("stripe webhook: handles customer.subscription.updated", () => {
  // The event the portal actually sent. Its absence was the bug.
  it("has a customer.subscription.updated branch", () => {
    expect(webhookSource()).toContain(UPDATED_GUARD);
  });

  // The decision itself is asserted against real payloads in the block below,
  // not by grepping for a field name here. An earlier version of this test did
  // grep for one -- `expect(block).toMatch(/subscription\.cancel_at_period_end/)`
  // -- and that is how the bug shipped: the handler read a field the Billing
  // Portal had stopped setting, and the test pinned it there rather than
  // catching it. All this asserts now is that the branch delegates.
  it("delegates the decision to the tested predicate", () => {
    expect(updatedHandlerBlock()).toContain("isPendingCancellation(subscription)");
  });

  it("fires subscription_canceled on the pending-cancellation path", () => {
    expect(updatedHandlerBlock()).toContain(CANCEL_EVENT);
  });

  // The two paths must be indistinguishable downstream, or every churn query
  // has to know which webhook reported it. Same property shape as .deleted.
  it("reports the same property shape as the .deleted path", () => {
    for (const block of [updatedHandlerBlock(), deletedHandlerBlock()]) {
      const start = block.indexOf(CANCEL_EVENT);
      expect(start).toBeGreaterThan(-1);
      const properties = block.slice(start, block.indexOf("}", start));
      expect(properties).toContain("plan:");
      expect(properties).toContain("provider: \"stripe\"");
    }
  });

  it("records the pending cancellation on the row", () => {
    expect(updatedHandlerBlock()).toMatch(/cancel_at_period_end:\s*true/);
  });

  // (a) ACCESS MUST CONTINUE. The customer paid for the current month and
  // /terms promises access to the end of it. Flipping status to canceled would
  // revoke it immediately and contradict the published terms; computeQuota
  // gates on status === "active", so that one word is the access switch.
  it("never sets status to canceled on the pending path", () => {
    expect(updatedHandlerBlock()).not.toContain("status: \"canceled\"");
  });

  it("does not write status at all on the pending path", () => {
    expect(updatedHandlerBlock()).not.toMatch(/\bstatus:\s*"/);
  });
});

describe("stripe webhook: fires subscription_canceled exactly once", () => {
  // (b) Stripe sent TWO .updated events seconds apart for ONE cancellation,
  // and .updated also fires for price changes, card updates and quantity
  // changes. The stripe_events table cannot help: it dedupes by event id, and
  // these are DIFFERENT ids. The guard therefore has to come from row state.
  it("reads the stored cancel_at_period_end before deciding to fire", () => {
    const block = updatedHandlerBlock();
    const select = block.indexOf(".select(");
    expect(select).toBeGreaterThan(-1);
    expect(block.slice(select, block.indexOf(")", select))).toContain(
      "cancel_at_period_end",
    );
  });

  it("fires only when the row does not already record a pending cancel", () => {
    const block = updatedHandlerBlock();
    const fire = block.indexOf(CANCEL_EVENT);
    expect(fire).toBeGreaterThan(-1);
    expect(block.slice(0, fire)).toMatch(/alreadyPending/);
  });

  // Write first, then report. If the order were reversed a failed write would
  // return 500, Stripe would retry the SAME event id, the stripe_events guard
  // would swallow it -- and the next .updated would fire a second event.
  it("writes the row before firing the event", () => {
    const block = updatedHandlerBlock();
    const write = block.indexOf("cancel_at_period_end: true");
    const fire = block.indexOf(CANCEL_EVENT);
    expect(write).toBeGreaterThan(-1);
    expect(fire).toBeGreaterThan(write);
  });

  it("explains why event-id idempotency is insufficient here", () => {
    expect(updatedHandlerBlock()).toMatch(/stripe_events|event id|different id/i);
  });
});

describe("stripe webhook: un-cancelling clears the pending state", () => {
  // (c) A customer can reverse a pending cancellation in the portal, which
  // sets cancel_at_period_end back to false and emits another .updated.
  it("clears cancel_at_period_end when Stripe reports false", () => {
    expect(updatedHandlerBlock()).toMatch(/cancel_at_period_end:\s*false/);
  });

  // No event: there is no reactivation event in experiment/EVENTS.yaml, and
  // firing subscription_activated would double-count a sale already reported
  // at checkout. The un-cancel branch must therefore be silent.
  it("fires no analytics event on the un-cancel branch", () => {
    const block = updatedHandlerBlock();
    const clear = block.indexOf("cancel_at_period_end: false");
    expect(clear).toBeGreaterThan(-1);
    expect(block.slice(clear)).not.toContain("trackServerEvent");
  });

  it("does not resurrect status on the un-cancel branch either", () => {
    const block = updatedHandlerBlock();
    const clear = block.indexOf("cancel_at_period_end: false");
    expect(block.slice(clear)).not.toMatch(/status:\s*"/);
  });
});

describe("stripe webhook: .deleted stays the signal for access ending", () => {
  // (d) The pre-existing handler is still correct and still required: it is
  // the only place where access actually ends.
  it("still flips status to canceled when the subscription really ends", () => {
    expect(deletedHandlerBlock()).toContain("status: \"canceled\"");
  });

  it("still fires subscription_canceled for a cancel never seen pending", () => {
    expect(deletedHandlerBlock()).toContain(CANCEL_EVENT);
  });

  // A portal cancellation reports on .updated and then elapses into .deleted
  // up to 30 days later. Without a guard that is TWO subscription_canceled
  // events for one cancellation. The already-recorded pending flag is what
  // suppresses the second.
  it("does not fire again when the pending cancellation merely elapsed", () => {
    const block = deletedHandlerBlock();
    const select = block.indexOf(".select(");
    expect(select).toBeGreaterThan(-1);
    expect(block.slice(select, block.indexOf(")", select))).toContain(
      "cancel_at_period_end",
    );
    expect(block.slice(0, block.indexOf(CANCEL_EVENT))).toMatch(
      /alreadyReported/,
    );
  });

  it("still resolves identity from stripe_subscription_id, not metadata", () => {
    const block = deletedHandlerBlock();
    expect(block).toContain("stripe_subscription_id");
    expect(block).not.toContain("session.metadata");
  });
});

describe("regression surface: nothing else moved", () => {
  // Rule 2: experiment/EVENTS.yaml is the canonical event list, and this change
  // alters WHEN subscription_canceled fires, not WHICH events exist. Pin the
  // whole emitted set rather than a blocklist, so an invented event name fails
  // here instead of quietly reaching PostHog.
  it("emits no event name that is not already declared in EVENTS.yaml", () => {
    const emitted = Array.from(
      webhookSource().matchAll(/trackServerEvent\("([a-z_]+)"/g),
      (match) => match[1],
    );
    expect(new Set(emitted)).toEqual(
      new Set([
        "subscription_activated",
        "subscription_canceled",
        "invoice_paid",
        "payment_failed",
      ]),
    );
  });

  it("keeps the checkout and invoice handlers in place", () => {
    const source = webhookSource();
    expect(source).toContain("event.type === \"checkout.session.completed\"");
    expect(source).toContain("event.type === \"invoice.paid\"");
    expect(source).toContain("event.type === \"invoice.payment_failed\"");
  });

  it("keeps the stripe_events event-id idempotency insert", () => {
    const source = webhookSource();
    expect(source).toContain("from(\"stripe_events\")");
    expect(source).toContain("23505");
  });
});

// The decision, run against payloads Stripe actually sent.
//
// This block is the one that fails against the pre-fix handler. Everything
// above it passed while cancellation was silently broken in production, which
// is the whole argument for testing the decision rather than the source text.
describe("isPendingCancellation: real Stripe payloads", () => {
  // VERBATIM from evt_1UKuEJRamJuooj63TxSnsho6, the cancellation that reported
  // nothing. Only the fields the predicate reads are kept; the rest of the
  // Subscription object is 200 lines of payment settings and price data that
  // the decision does not consult. cancel_at equals the item's
  // current_period_end (1793254123) exactly -- that IS how the portal says
  // "cancel when the paid month runs out".
  const PORTAL_CANCELLATION = {
    cancel_at: 1793254123,
    cancel_at_period_end: false,
  };

  // Same subscription two seconds later. previous_attributes on this one was
  // only { cancellation_details: { feedback: null } } -- the customer picking
  // "too_expensive" from the portal's dropdown. The cancellation fields are
  // unchanged, so the predicate must still read pending; it is the stored row
  // flag, not this function, that stops the second report.
  const FEEDBACK_FOLLOW_UP = {
    cancel_at: 1793254123,
    cancel_at_period_end: false,
  };

  // Reversing the cancellation clears the scheduled end date.
  const UN_CANCELLED = { cancel_at: null, cancel_at_period_end: false };

  // A price change, a card update, a quantity change: .updated fires for all
  // of these and none of them is a cancellation.
  const UNRELATED_UPDATE = { cancel_at: null, cancel_at_period_end: false };

  // The older shape, still produced when a caller sets the flag through the
  // API directly. Dropping support for it would trade this bug for its mirror.
  const LEGACY_FLAG = { cancel_at: null, cancel_at_period_end: true };

  it("detects the portal cancellation that shipped broken", () => {
    expect(isPendingCancellation(PORTAL_CANCELLATION)).toBe(true);
  });

  it("still reads pending on the feedback follow-up event", () => {
    expect(isPendingCancellation(FEEDBACK_FOLLOW_UP)).toBe(true);
  });

  it("detects a cancellation set through the legacy flag", () => {
    expect(isPendingCancellation(LEGACY_FLAG)).toBe(true);
  });

  it("reads not-pending once the cancellation is reversed", () => {
    expect(isPendingCancellation(UN_CANCELLED)).toBe(false);
  });

  it("does not treat an unrelated subscription update as a cancellation", () => {
    expect(isPendingCancellation(UNRELATED_UPDATE)).toBe(false);
  });

  // Absent is not the same as false, and a webhook payload may omit either
  // field. Neither present means nothing was scheduled.
  it("treats missing fields as not pending", () => {
    expect(isPendingCancellation({})).toBe(false);
    expect(isPendingCancellation({ cancel_at: undefined })).toBe(false);
    expect(isPendingCancellation({ cancel_at_period_end: null })).toBe(false);
  });

  // REGRESSION GUARD, and the sharpest assertion in the file. Reading only
  // cancel_at_period_end is precisely the defect that reached production and
  // survived a full test suite. If someone simplifies the predicate back to
  // that one field, this is what stops them.
  it("never decides on cancel_at_period_end alone", () => {
    expect(isPendingCancellation({ cancel_at_period_end: false })).toBe(false);
    expect(
      isPendingCancellation({ cancel_at: 1793254123, cancel_at_period_end: false }),
    ).toBe(true);
  });
});
