// The forensic signal breakdown, and who is allowed to see it.
//
// WHY IT EXISTS. On launch day the first live subscriber paid $60 and still
// saw the locked, blurred breakdown. The branch that chose between locked and
// unlocked made no subscription check at all:
//
//   {fraudSignals.length > 0 ? <LockedSignals .../> : ...}
//
// SignalBreakdown, the component that renders the real list, sat in the same
// folder and was imported nowhere. "Per-signal breakdown & explanations" is
// sold on the pricing page, so the headline paid feature had never been
// visible to anyone who bought it.
//
// vitest runs environment "node" with no jsdom, so the component cannot be
// rendered here. The entitlement rule is therefore a pure function, tested
// directly, plus the few structural assertions that have no other guard.
//
// SECOND BUG, SAME FUNCTION. The rule used to be `status === "active"` and
// nothing else, with no date in scope. A Stripe subscription has a webhook to
// flip its status; a COMPED row does not, so once granted it entitled its
// owner to Pro forever. hasProAccess now takes the whole entitlement row and
// the current instant, which is why the cases below are a table rather than a
// list of status strings.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { entitlementTier, hasProAccess } from "@/lib/pro-access";
import type { EntitlementRow } from "@/lib/pro-access";
import type { SubscriptionsRow } from "@/lib/types";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) =>
  readFileSync(path.join(repoRoot, ...p), "utf8");

const CLIENT = ["src", "app", "scan-result", "scan-result-client.tsx"];

/** The instant every case below is judged against. */
const NOW = new Date("2026-11-02T12:00:00.000Z");
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
/** A row with a Stripe subscription behind it. */
const STRIPE_ID = "sub_1QabcdEFghijkLM";

// Defaults are a COMPED grant: active, no Stripe subscription, no end date --
// the shape every comp written before migration 009 actually has.
const row = (over: Partial<EntitlementRow> = {}): EntitlementRow => ({
  status: "active",
  stripe_subscription_id: null,
  current_period_end: null,
  ...over,
});

describe("hasProAccess", () => {
  // THE BOUNDARY IS EXCLUSIVE: the rule is current_period_end > now, so a comp
  // whose end date is exactly now has ENDED. current_period_end is the first
  // instant of the next period, not the last instant of this one -- it is what
  // Stripe bills on, and treating it as still-covered would give every grant an
  // extra instant and make the "expired" and "not yet expired" sets overlap.
  const cases: ReadonlyArray<readonly [string, EntitlementRow | null, boolean]> = [
    ["an active Stripe subscription", row({ stripe_subscription_id: STRIPE_ID }), true],

    // STRIPE IS THE AUTHORITY, and this case is the reason the Stripe branch
    // comes before the date branch. current_period_end is refreshed by
    // invoice.paid; if that webhook is late, slow or retried, the stored date
    // goes stale while the customer is still being billed. Expiring on the
    // stored date would revoke paid access over OUR bookkeeping lag.
    [
      "a Stripe subscription whose stored period end is already past",
      row({ stripe_subscription_id: STRIPE_ID, current_period_end: PAST }),
      true,
    ],

    // Every comp granted before migration 009 is NULL-dated and must keep
    // working: a lifetime grant bills on no interval, so NULL is the truthful
    // answer, not a missing one.
    ["a comped grant with no end date", row(), true],
    ["a comped grant inside its window", row({ current_period_end: FUTURE }), true],

    // THE BUG. This row entitled its owner to Pro forever.
    ["a comped grant past its end date", row({ current_period_end: PAST }), false],
    [
      "a comped grant ending at exactly this instant",
      row({ current_period_end: NOW.toISOString() }),
      false,
    ],

    // Status still governs first, whatever the dates say.
    ["an inactive row", row({ status: "inactive", current_period_end: FUTURE }), false],
    ["a canceled row", row({ status: "canceled", current_period_end: FUTURE }), false],
    [
      "a past_due row",
      row({ status: "past_due", stripe_subscription_id: STRIPE_ID }),
      false,
    ],

    // No row at all: a free user who has never subscribed. maybeSingle()
    // returns null, which must not be truthy.
    ["no row at all", null, false],
  ];

  it.each(cases)("%s -> %s", (_label, sub, expected) => {
    expect(hasProAccess(sub, NOW)).toBe(expected);
  });

  // THE PENDING-CANCELLATION CASE. Cancelling in the portal leaves status
  // active until the paid period ends -- only customer.subscription.deleted
  // moves it to canceled. Gating on cancel_at_period_end instead would revoke
  // the breakdown the moment they click cancel, taking away a month they have
  // already paid for. It keeps working for free under the new rule: such a row
  // has a stripe_subscription_id, so status alone decides it.
  it("keeps access through a pending cancellation", () => {
    expect(
      hasProAccess(row({ stripe_subscription_id: STRIPE_ID }), NOW),
    ).toBe(true);
  });

  // Dunning is still retrying their card. Treating past_due as paid hands a
  // free month to anyone whose payment bounces.
  it("refuses a past_due subscription even with time left on the clock", () => {
    expect(
      hasProAccess(row({ status: "past_due", current_period_end: FUTURE }), NOW),
    ).toBe(false);
  });

  // Guards the comparison itself. "Active" or " active " must not pass: the
  // column is written only by the webhook and the type says so, but these rows
  // arrive from Supabase as untyped JSON, and a lenient match here would
  // quietly widen who counts as paid. The cast is what a caller reading
  // maybeSingle() has anyway.
  it("matches the status string exactly", () => {
    const as = (s: string) =>
      row({ status: s as SubscriptionsRow["status"] });
    expect(hasProAccess(as("Active"), NOW)).toBe(false);
    expect(hasProAccess(as("ACTIVE"), NOW)).toBe(false);
    expect(hasProAccess(as(" active"), NOW)).toBe(false);
    expect(hasProAccess(as(""), NOW)).toBe(false);
  });

  // A malformed date must not read as "no end date". Date("nonsense") is
  // Invalid Date, and every comparison against it is false -- including
  // `end > now` -- so an unparseable value fails CLOSED here rather than
  // granting the perpetual access a NULL grants.
  it("refuses a comp whose end date cannot be parsed", () => {
    expect(hasProAccess(row({ current_period_end: "not-a-date" }), NOW)).toBe(
      false,
    );
  });
});

// STRUCTURAL. These cover the wiring, which cannot be exercised without a DOM.
// Few on purpose -- a source-grep test pins a spelling rather than a behaviour.
describe("the breakdown is actually wired to that rule", () => {
  // The regression itself: SignalBreakdown existed but nothing imported it.
  it("imports the unlocked breakdown component", () => {
    expect(read(...CLIENT)).toContain('from "./signal-breakdown"');
  });

  // Both outcomes must be reachable from the same branch. Before the fix only
  // LockedSignals appeared, which is why paying changed nothing.
  it("can render either the locked or the unlocked view", () => {
    const src = read(...CLIENT);
    expect(src).toContain("<SignalBreakdown");
    expect(src).toContain("<LockedSignals");
  });

  // The decision goes through the tested rule rather than an inline string
  // comparison -- an inline check is the shape of what went missing before.
  //
  // IT NAMES entitlementTier, NOT hasProAccess, AND THAT IS NOT A WEAKENING.
  // b-13 gave this page a third audience: a scan-pack buyer, who is shown the
  // single top reason and still not the breakdown. entitlementTier is the rule
  // that sorts the three, and it answers "pro" from hasProAccess and from
  // nothing else (src/lib/pro-access.ts) -- so the Pro gate is the same
  // predicate, reached through one more function.
  // tests/entitlement-tier.test.ts holds the behavioural pair: hasProAccess
  // stays FALSE for a pack buyer while entitlementTier returns "pack".
  //
  // The assertion this replaced read RAW source, so the comment block above
  // the subscription read satisfied it on its own -- that prose still names
  // hasProAccess while explaining the layering. This one reads code only, for
  // the same reason the ban below does.
  it("decides via entitlementTier", () => {
    const src = read(...CLIENT);

    // CODE ONLY. Comment lines are stripped first -- the prose above the rule
    // names the very comparison being banned, and an assertion that cannot
    // tell code from the comment describing it fails on correct work.
    // tests/no-unbuilt-claims.test.ts strips comments for the same reason,
    // after a guard there matched the word it was documenting.
    const code = src
      .split(/\r?\n/)
      .filter((line) => {
        const t = line.trim();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .join(" ");
    expect(code).toContain("entitlementTier(");
    expect(code).toMatch(/tier === "pro"/);
    expect(code).not.toMatch(/status\s*===\s*"active"/);
  });

  // FAILS CLOSED. The tier must START at the least-privileged one, so the gap
  // before the subscription read resolves shows the fully locked view.
  //
  // This used to read /useState\(false\)/ against a boolean isPro. The state
  // is a tier now, and the invariant has to survive the change of type: it is
  // not "the literal false", it is "whatever reveals least". So the expected
  // value is taken FROM THE RULE -- what entitlementTier answers for a user
  // who has never transacted -- rather than hardcoded here. Initialising the
  // state to "pro" or to "pack" fails this; so does deleting the type
  // argument, because then there is no declared initial tier to read.
  it("defaults to the least-privileged tier while the subscription is still loading", () => {
    const code = read(...CLIENT)
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    const declared = code.match(/useState<EntitlementTier>\("(\w+)"\)/);
    expect(
      declared,
      "the tier state is no longer initialised with a literal tier",
    ).not.toBeNull();
    expect(declared![1]).toBe(entitlementTier(null, new Date()));
  });
});
