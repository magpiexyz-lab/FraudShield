import { describe, it, expect } from "vitest";
import {
  interpretCheckoutResponse,
  CHECKOUT_NETWORK_MESSAGE,
  NOT_CONFIGURED_FALLBACK_MESSAGE,
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
