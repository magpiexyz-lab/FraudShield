import { describe, it, expect } from "vitest";
import {
  interpretCheckoutResponse,
  CHECKOUT_NETWORK_MESSAGE,
  NOT_CONFIGURED_FALLBACK_MESSAGE,
  ALREADY_SUBSCRIBED_FALLBACK_MESSAGE,
} from "./checkout-client";

// The two upgrade CTAs (/pricing and /scan-result) both POST /api/checkout and
// must react identically to every status the route can return. Phase 3 charges
// real money, so the two properties that matter are:
//   1. a failed attempt NEVER renders a success/confirmation state, and
//   2. every non-redirecting outcome is recoverable (the caller resets its
//      one-shot latch), so a 429 or a network blip cannot brick the button.
// This module is the shared decision table both components consume.
describe("interpretCheckoutResponse", () => {
  it("redirects on 200 with a url", () => {
    const outcome = interpretCheckoutResponse(200, {
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    expect(outcome).toEqual({
      kind: "redirect",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
  });

  it("treats a 200 without a url as an error, never a success", () => {
    expect(interpretCheckoutResponse(200, {}).kind).toBe("error");
  });

  it("treats a 200 with a non-string url as an error", () => {
    expect(interpretCheckoutResponse(200, { url: 42 }).kind).toBe("error");
  });

  it("maps 503 + code not_configured to the waitlist product state", () => {
    const outcome = interpretCheckoutResponse(503, {
      error: "not_configured",
      code: "not_configured",
      message: "Pro upgrade is coming soon. Join the waitlist to be notified.",
    });
    expect(outcome).toEqual({
      kind: "not_configured",
      message: "Pro upgrade is coming soon. Join the waitlist to be notified.",
    });
  });

  it("falls back to a default message when a not_configured 503 omits one", () => {
    const outcome = interpretCheckoutResponse(503, { code: "not_configured" });
    expect(outcome).toEqual({
      kind: "not_configured",
      message: NOT_CONFIGURED_FALLBACK_MESSAGE,
    });
  });

  it("treats a 503 without the not_configured code as a plain error", () => {
    expect(interpretCheckoutResponse(503, { error: "boom" }).kind).toBe("error");
  });

  it("returns a sign-in message on 401", () => {
    const outcome = interpretCheckoutResponse(401, { error: "Unauthorized" });
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toMatch(/sign in/i);
  });

  it("returns a permission message on 403", () => {
    const outcome = interpretCheckoutResponse(403, { error: "Forbidden" });
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toMatch(
      /not allowed|permission|account/i,
    );
  });

  it("returns a slow-down message on 429", () => {
    const outcome = interpretCheckoutResponse(429, { error: "Too many requests" });
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toMatch(
      /too many|moment|wait/i,
    );
  });

  it("returns a retryable message on 400", () => {
    const outcome = interpretCheckoutResponse(400, { error: "Invalid request" });
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message.length).toBeGreaterThan(0);
  });

  it("returns a generic retry message on 500", () => {
    const outcome = interpretCheckoutResponse(500, { error: "Checkout failed" });
    expect(outcome.kind).toBe("error");
    expect(outcome.kind === "error" && outcome.message).toMatch(/try again/i);
  });

  it("survives an unparseable body on every failure status", () => {
    for (const status of [400, 401, 403, 429, 500, 503, 502]) {
      const outcome = interpretCheckoutResponse(status, null);
      expect(outcome.kind).toBe("error");
      expect(outcome.kind === "error" && outcome.message.length).toBeGreaterThan(0);
    }
  });

  it("never returns a success-shaped outcome for a failed charge attempt", () => {
    for (const status of [400, 401, 403, 429, 500, 502, 503]) {
      const outcome = interpretCheckoutResponse(status, { url: "https://evil" });
      expect(outcome.kind).not.toBe("redirect");
    }
  });

  it("exposes a user-readable network failure message", () => {
    expect(CHECKOUT_NETWORK_MESSAGE).toMatch(/connect|try again|network/i);
  });
});

// A subscriber clicking "Choose Pro" used to open a working checkout and buy a
// SECOND subscription: Stripe holds both, so the customer is billed $120/month,
// and the webhook's upsert on user_id repoints our row at whichever completed
// last - leaving the first one billing while invisible to us. It happened to
// the test account during phase-3 verification. /api/checkout now answers 409
// already_subscribed, and this is the table that turns that into a calm panel
// rather than a red retry prompt.
describe("interpretCheckoutResponse: already subscribed", () => {
  const PAYLOAD = {
    error: "already_subscribed",
    code: "already_subscribed",
    message: "You are already on Pro.",
  };

  it("reads 409 + already_subscribed as its own outcome", () => {
    expect(interpretCheckoutResponse(409, PAYLOAD)).toEqual({
      kind: "already_subscribed",
      message: "You are already on Pro.",
    });
  });

  // The distinction is the whole point: "error" renders red, role="alert", and
  // invites a retry the server will refuse again. Nothing failed here.
  it("is not classified as an error", () => {
    expect(interpretCheckoutResponse(409, PAYLOAD).kind).not.toBe("error");
  });

  it("falls back to its own copy when the server sends no message", () => {
    const outcome = interpretCheckoutResponse(409, {
      code: "already_subscribed",
    });
    expect(outcome).toEqual({
      kind: "already_subscribed",
      message: ALREADY_SUBSCRIBED_FALLBACK_MESSAGE,
    });
  });

  // Never invent the state from a bare status code. A 409 from a proxy, or any
  // other conflict the route grows later, must not tell a NON-subscriber they
  // are already paying - that would block a sale outright.
  it("requires the code, not just the status", () => {
    expect(interpretCheckoutResponse(409, {}).kind).toBe("error");
    expect(interpretCheckoutResponse(409, { code: "something_else" }).kind).toBe(
      "error",
    );
  });

  // And the mirror: the code alone must not override a status that means
  // something else entirely.
  it("does not fire on other statuses carrying the code", () => {
    expect(interpretCheckoutResponse(500, PAYLOAD).kind).toBe("error");
    expect(interpretCheckoutResponse(200, { ...PAYLOAD, url: "https://x/y" })
      .kind).toBe("redirect");
  });
});
