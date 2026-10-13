// Keeping the browser's PostHog person in step with the signed-in user.
//
// WHY IT EXISTS. A paid test checkout on 12 Oct 2026 landed its browser events
// and its server events on two different PostHog people:
//
//   checkout_started        (web)          person 5acbff54...
//   subscription_activated  (posthog-node) person 5230fbe3...
//
// One buyer, counted twice, and a funnel between those two events reads 0%.
// The cause was that identify() lived on the auth PAGES, and two of the four
// ways into a session -- email-confirmation signup and Google OAuth -- both
// land on /auth/callback, a server route handler that cannot run client code.
//
// vitest runs environment "node" with no jsdom, so the component itself cannot
// be rendered here. The decision it makes is therefore a pure function, tested
// directly, plus a small number of structural assertions for the wiring that
// has no other guard.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { shouldIdentify } from "@/lib/analytics-identity";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) =>
  readFileSync(path.join(repoRoot, ...p), "utf8");

const USER_ID = "5230fbe3-142c-4904-abe2-d71ddd3da2eb";
const ANON_ID = "5acbff54-c125-4f96-93eb-0f3973459926";

describe("shouldIdentify", () => {
  // THE BUG ITSELF, as a test. The anonymous browser id and the Supabase user
  // id are the two real ids from the 12 Oct split.
  it("identifies when the browser is still on its anonymous id", () => {
    expect(shouldIdentify(ANON_ID, USER_ID)).toBe(true);
  });

  // Every page load after the first. posthog-js sends an $identify event each
  // time, so re-identifying on every mount would add a write per page view
  // and tell us nothing new.
  it("does not re-identify a browser that already matches the user", () => {
    expect(shouldIdentify(USER_ID, USER_ID)).toBe(false);
  });

  // PostHog not loaded, or blocked by an extension. Identifying is the safe
  // side of this trade: a redundant identify costs one event, a skipped one
  // costs a permanently split person.
  it("identifies when the distinct id cannot be read", () => {
    expect(shouldIdentify(undefined, USER_ID)).toBe(true);
  });

  // THE DANGEROUS INPUT. identify("") would collapse every anonymous visitor
  // into a single shared person, which is worse than the bug being fixed:
  // it is not recoverable by a later correct call.
  it("never identifies without a real user id", () => {
    expect(shouldIdentify(ANON_ID, null)).toBe(false);
    expect(shouldIdentify(ANON_ID, undefined)).toBe(false);
    expect(shouldIdentify(ANON_ID, "")).toBe(false);
  });

  it("treats a signed-out browser as nothing to do", () => {
    expect(shouldIdentify(undefined, null)).toBe(false);
  });
});

// STRUCTURAL, and only where there is no alternative. These assert wiring that
// cannot be exercised without a DOM. They are deliberately few: a source-grep
// test pins a spelling rather than a behaviour, and this project has already
// had one such test pin a defect in place.
describe("the identity component is actually wired up", () => {
  // The whole point of the fix is that no auth route can bypass it. Mounted
  // anywhere narrower than the root layout and the original bug returns the
  // next time someone adds a sign-in path.
  it("is mounted in the root layout", () => {
    const layout = read("src", "app", "layout.tsx");
    expect(layout).toContain("AnalyticsIdentity");
    expect(layout).toMatch(/<AnalyticsIdentity\s*\/>/);
  });

  // The second half of the bug, and independently harmful: without reset() the
  // next person to sign up on a shared browser inherits the previous user's
  // distinct id, merging two real accounts into one person.
  it("resets the person on sign-out", () => {
    const component = read("src", "components", "AnalyticsIdentity.tsx");
    expect(component).toContain("SIGNED_OUT");
    expect(component).toContain("reset()");
  });

  // Reaching for posthog directly would bypass the library's global properties
  // (project_name, project_owner), which is what separates this experiment
  // from the others in a shared PostHog project. CLAUDE.md Rule 2.
  it("goes through the analytics library rather than posthog directly", () => {
    const component = read("src", "components", "AnalyticsIdentity.tsx");
    expect(component).toContain('from "@/lib/analytics"');
    expect(component).not.toMatch(/from\s+"posthog-js"/);
  });
});
