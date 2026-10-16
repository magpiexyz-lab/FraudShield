// The pricing page's Pro card, for a signed-in visitor who has not scanned yet.
//
// WHAT CHANGED AND WHY. The card used to refuse checkout to anyone who had
// never received a fraud score: onChoosePro() set state "needs_activation" and
// the button was REPLACED by a "try it first" pointer. That was right for the
// Phase 2 fake door, where the question was whether people who had USED the
// product would pay, and a click from someone who had scanned nothing measured
// curiosity rather than intent.
//
// With real checkout the question changed. A signed-in visitor asking to pay
// is the highest-intent signal on the page, and sending them away to scan
// something first is a detour that costs sales. The free scan is now offered
// BESIDE the buy button instead of in place of it.
//
// The scan-result paywall is deliberately untouched: there, the user has seen
// their score and the lock is the offer.
//
// vitest runs environment "node" with no jsdom, so this component cannot be
// rendered. These are source-contract tests over the card.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

const PRICING = readFileSync(
  path.join(repoRoot, "src", "app", "pricing", "pricing-plans.tsx"),
  "utf8",
);

const CHECKOUT_ROUTE = readFileSync(
  path.join(repoRoot, "src", "app", "api", "checkout", "route.ts"),
  "utf8",
);

const SCAN_RESULT = readFileSync(
  path.join(repoRoot, "src", "app", "scan-result", "scan-result-client.tsx"),
  "utf8",
);

/** Source with comment lines stripped, so prose describing a rule is never
 *  mistaken for the rule. A guard in this repo has already matched the very
 *  word it was documenting. */
const codeOnly = (src: string): string =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join(" ");

describe("the activation gate is gone from pricing", () => {
  // THE CHANGE ITSELF. Any reappearance of this state means the detour is back.
  it("has no needs_activation state", () => {
    expect(codeOnly(PRICING)).not.toContain("needs_activation");
  });

  // The component that replaced the button. Its absence is what guarantees the
  // button is no longer replaceable by it.
  it("no longer renders a try-it-first panel in the button's place", () => {
    expect(PRICING).not.toContain("TryItFirstPointer");
  });
});

describe("a zero-scan visitor gets both", () => {
  // BOTH, not either. The manager's requirement in one assertion: the card
  // offers the free scan as an option while the buy button stays available.
  it("shows the free-scan pointer as a separate, additive element", () => {
    expect(PRICING).toContain("showFreeScanPointer");
    expect(PRICING).toContain("Scan a document free");
  });

  // Only once the probe has resolved to a real "no scans yet". hasActivated is
  // tri-state and null means still loading -- a pointer that appears a beat
  // after the card settles reads as a glitch.
  it("waits for the scan probe rather than guessing", () => {
    expect(codeOnly(PRICING)).toContain("hasActivated === false");
  });

  // A subscriber has already paid for 200 scans a month. Nudging them toward a
  // free one is the same mistake the old branch ordering existed to avoid.
  it("never shows the pointer to someone already paying", () => {
    expect(codeOnly(PRICING)).toContain("!subscribed");
  });
});

describe("what must NOT have changed", () => {
  // The server was never gated on activation, so this change removed a
  // client-side restriction rather than a protection. If a gate ever appears
  // here, the pricing page would start failing for exactly the users it was
  // just opened up to.
  it("leaves the checkout route ungated on activation", () => {
    expect(codeOnly(CHECKOUT_ROUTE)).not.toMatch(/needs_activation/);
  });

  // The 409 that stops a subscriber buying a second $60/month subscription.
  it("still refuses a second subscription", () => {
    expect(CHECKOUT_ROUTE).toContain("already_subscribed");
  });

  // Explicitly out of scope: the paywall on the results page stays as it was.
  it("leaves the scan-result paywall in place", () => {
    expect(SCAN_RESULT).toContain("<LockedSignals");
    expect(SCAN_RESULT).toContain("hasProAccess");
  });

  // Already correct before this change, and worth pinning so it stays that
  // way: /dashboard is the upload surface, so a buyer lands where they can
  // immediately use what they bought.
  it("lands a new subscriber on the upload page", () => {
    expect(CHECKOUT_ROUTE).toContain("/dashboard?checkout=success");
  });
});
