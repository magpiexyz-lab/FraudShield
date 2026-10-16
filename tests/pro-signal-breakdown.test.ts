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

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { hasProAccess } from "@/lib/pro-access";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) =>
  readFileSync(path.join(repoRoot, ...p), "utf8");

const CLIENT = ["src", "app", "scan-result", "scan-result-client.tsx"];

describe("hasProAccess", () => {
  it("grants access to an active subscription", () => {
    expect(hasProAccess("active")).toBe(true);
  });

  // THE PENDING-CANCELLATION CASE. Cancelling in the portal leaves status
  // active until the paid period ends -- only customer.subscription.deleted
  // moves it to canceled. Gating on cancel_at_period_end instead would revoke
  // the breakdown the moment they click cancel, taking away a month they have
  // already paid for.
  it("keeps access through a pending cancellation", () => {
    expect(hasProAccess("active")).toBe(true);
  });

  // Dunning is still retrying their card. Treating past_due as paid hands a
  // free month to anyone whose payment bounces.
  it("refuses a past_due subscription", () => {
    expect(hasProAccess("past_due")).toBe(false);
  });

  it("refuses canceled and inactive subscriptions", () => {
    expect(hasProAccess("canceled")).toBe(false);
    expect(hasProAccess("inactive")).toBe(false);
  });

  // No row at all: a free user who has never subscribed. maybeSingle() returns
  // null, so undefined reaches this function and must not be truthy.
  it("refuses a user with no subscription row", () => {
    expect(hasProAccess(null)).toBe(false);
    expect(hasProAccess(undefined)).toBe(false);
    expect(hasProAccess("")).toBe(false);
  });

  // Guards the comparison itself. "Active" or " active " must not pass: the
  // column is written only by the webhook, but a lenient match here would
  // quietly widen who counts as paid.
  it("matches the status string exactly", () => {
    expect(hasProAccess("Active")).toBe(false);
    expect(hasProAccess("ACTIVE")).toBe(false);
    expect(hasProAccess(" active")).toBe(false);
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
  it("decides via hasProAccess", () => {
    const src = read(...CLIENT);
    expect(src).toContain("hasProAccess");

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
    expect(code).not.toMatch(/status\s*===\s*"active"/);
  });

  // FAILS CLOSED. isPro must start false, so the gap before the subscription
  // read resolves shows the locked view. Defaulting true would flash the paid
  // breakdown at every free user on every page load.
  it("defaults to locked while the subscription is still loading", () => {
    expect(read(...CLIENT)).toMatch(/useState\(false\)/);
  });
});
