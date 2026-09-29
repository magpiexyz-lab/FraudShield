// Shared client-side decision table for POST /api/checkout.
//
// Phase 3 takes real money, so both upgrade surfaces (/pricing and the
// scan-result CTA) must agree on what each response means. Two rules:
//   - a failed attempt never renders a confirmation state, and
//   - every outcome that does not navigate is recoverable, so the caller can
//     release its fire-once latch and let the user try again.
//
// 503 + code "not_configured" is a PRODUCT STATE, not an error: Stripe is not
// wired up in this environment, so the honest move is to collect the demand
// signal (waitlist) rather than show a red retry prompt.

export type CheckoutOutcome =
  | { kind: "redirect"; url: string }
  | { kind: "not_configured"; message: string }
  | { kind: "error"; message: string };

export const NOT_CONFIGURED_FALLBACK_MESSAGE =
  "Pro upgrade is coming soon. Join the waitlist to be notified.";

export const CHECKOUT_NETWORK_MESSAGE =
  "We could not reach the server. Check your connection and try again.";

const GENERIC_ERROR_MESSAGE = "We could not start checkout. Please try again.";

export function interpretCheckoutResponse(
  status: number,
  payload: unknown,
): CheckoutOutcome {
  const body = (
    payload && typeof payload === "object" ? payload : {}
  ) as { url?: unknown; code?: unknown; message?: unknown };

  if (status === 200) {
    // A 200 with no url means Stripe handed back a session we cannot use.
    // Treat it as a failure - showing success here would tell the user they
    // had paid when no checkout ever opened.
    if (typeof body.url === "string" && body.url.length > 0) {
      return { kind: "redirect", url: body.url };
    }
    return { kind: "error", message: GENERIC_ERROR_MESSAGE };
  }

  if (status === 503 && body.code === "not_configured") {
    const message =
      typeof body.message === "string" && body.message.length > 0
        ? body.message
        : NOT_CONFIGURED_FALLBACK_MESSAGE;
    return { kind: "not_configured", message };
  }

  switch (status) {
    case 401:
      return {
        kind: "error",
        message: "Your session has expired. Please sign in again to upgrade.",
      };
    case 403:
      return {
        kind: "error",
        message: "This account is not allowed to start a Pro upgrade.",
      };
    case 429:
      return {
        kind: "error",
        message: "Too many attempts. Wait a moment and try again.",
      };
    case 400:
      return {
        kind: "error",
        message:
          "We could not start checkout with those details. Refresh the page and try again.",
      };
    default:
      return { kind: "error", message: GENERIC_ERROR_MESSAGE };
  }
}
