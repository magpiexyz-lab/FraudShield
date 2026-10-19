// Asking the people who closed the tab.
//
// WHY IT EXISTS. The prompt on /pricing?checkout=cancelled only catches
// someone who presses Stripe's back button. Everyone who closes the tab never
// returns to a URL we control -- and they are the larger group: four live
// Checkout Sessions expired in the first days of the phase 3 campaign without
// one of them landing back on a page that could ask.
//
// Stripe reports those about a day later via checkout.session.expired. By then
// the person is gone, so the webhook only sets a flag; the dashboard spends it
// the next time they sign in.
//
// vitest runs environment "node" with no jsdom and no Stripe, so these are
// source contracts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (...p: string[]) => readFileSync(path.join(repoRoot, ...p), "utf8");

const WEBHOOK = read("src", "app", "api", "webhooks", "stripe", "route.ts");

/**
 * Just the expired handler, bounded by the start of the next one.
 *
 * An earlier version took a fixed character window, which ran past the end of
 * this block into customer.subscription.deleted and tripped on that handler's
 * customer_email and status: 500 -- reading correct code as a failure.
 */
function expiredHandler(): string {
  const start = WEBHOOK.indexOf('event.type === "checkout.session.expired"');
  if (start === -1) return "";
  const end = WEBHOOK.indexOf('event.type === "customer.subscription.deleted"', start);
  const block = end === -1 ? WEBHOOK.slice(start) : WEBHOOK.slice(start, end);
  // Comments stripped as well as bounded. Every assertion here is about what
  // the code does, and this handler's own comment explains that identity must
  // never come from customer_email — which read as the thing it forbids.
  return codeOnly(block);
}

/** Source with comment lines removed, so prose is never read as code. */
function codeOnly(src: string): string {
  const NL = String.fromCharCode(10);
  return src
    .split(NL)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join(NL);
}
const FOLLOWUP = read("src", "app", "dashboard", "abandon-followup.tsx");
const DASHBOARD = read("src", "app", "dashboard", "page.tsx");
const PROMPT = read("src", "app", "pricing", "abandon-reason-prompt.tsx");

describe("the webhook flags an abandoned checkout", () => {
  it("handles checkout.session.expired", () => {
    expect(WEBHOOK).toContain('event.type === "checkout.session.expired"');
  });

  // IDENTITY FROM METADATA, NEVER FROM EMAIL. customer_email is
  // attacker-controllable; the user_id was written server-side by an
  // authenticated route. Same rule the completed handler follows.
  it("takes the user from session metadata, not customer_email", () => {
    const block = expiredHandler();
    expect(block).toContain("session.metadata?.user_id");
    expect(block).not.toContain("customer_email");
  });

  // app_metadata cannot be written by the user's own session, so the prompt
  // cannot be re-triggered from the browser.
  it("writes the flag to app_metadata", () => {
    const block = expiredHandler();
    expect(block).toContain("app_metadata");
    expect(block).toContain("CHECKOUT_ABANDONED_KEY");
    expect(block).not.toContain("user_metadata");
  });

  // provider and providers live in the same bag.
  it("preserves the metadata already on the account", () => {
    const block = expiredHandler();
    expect(block).toContain("...appMeta");
  });

  // A missed flag costs one survey answer. A non-2xx response would make
  // Stripe retry the event for days over a measurement nicety.
  it("never fails the webhook over a flag it could not write", () => {
    const block = expiredHandler();
    expect(block).toContain("try {");
    expect(block).toContain("catch");
    expect(block).not.toContain("status: 500");
  });
});

describe("the dashboard spends the flag", () => {
  it("reads it from the session rather than the database", () => {
    expect(FOLLOWUP).toContain("supabase.auth.getUser()");
    expect(FOLLOWUP).toContain("app_metadata");
    expect(FOLLOWUP).toContain("checkout_abandoned_at");
  });

  it("is mounted on the dashboard", () => {
    expect(DASHBOARD).toContain("<AbandonFollowup />");
    expect(DASHBOARD).toContain('from "./abandon-followup"');
  });

  // THE TWO SURFACES MUST NOT BOTH ASK. One shared record of having answered,
  // not a second copy of the rule.
  it("shares one answered-check with the pricing prompt", () => {
    expect(PROMPT).toContain("export function abandonPromptAnswered");
    expect(FOLLOWUP).toContain("abandonPromptAnswered()");
  });

  // Not asking is always the safe outcome. This is a measurement; a failure to
  // determine eligibility must never surface to the user or retry.
  it("stays silent when it cannot tell", () => {
    expect(FOLLOWUP).toContain("catch");
    const start = FOLLOWUP.indexOf("if (!visible)");
    expect(FOLLOWUP.slice(start, start + 60)).toContain("return null");
  });
});

describe("one question, two triggers, one implementation", () => {
  // The markup is shared. Two copies of the same card would drift, and the
  // answers would stop being comparable between surfaces.
  it("reuses the same card on both surfaces", () => {
    expect(PROMPT).toContain("export function AbandonReasonCard");
    expect(FOLLOWUP).toContain("AbandonReasonCard");
  });

  // The pricing trigger must stay tied to the return URL, not leak onto every
  // pricing visit now that the card is separately exported.
  it("keeps the cancelled-return trigger on the pricing surface only", () => {
    expect(PROMPT).toContain('searchParams.get("checkout") === "cancelled"');
    expect(codeOnly(FOLLOWUP)).not.toContain("checkout=cancelled");
  });
});
