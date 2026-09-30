// POST /api/checkout - create a Stripe Checkout Session for the chosen plan.
//
// Phase 3: this is a real MONTHLY SUBSCRIPTION (mode: "subscription") billed
// against a Price created in the Stripe dashboard, in TEST mode only.
//
// Security:
//   - Authenticated via Supabase cookie session
//   - Rate-limited (after auth) per IP - burst protection on Vercel
//   - Plan price is read SERVER-SIDE from PLAN_PRICES - the client never
//     supplies a price. Plan slug is validated against a closed enum, and the
//     amount actually charged comes from a dashboard Price id held in env.
//   - Stripe metadata carries user_id + plan + amount_cents + attribution so
//     the webhook handler can mark the subscription active and the Phase 3
//     retention handlers can attribute churn.
//
// NOT gated on activation. /api/pay-intent refuses users who have never run a
// scan, because a fake-door click from someone who has not seen the product
// measures curiosity and inflates the Phase 2 numerator. That reasoning does
// NOT transfer to a real checkout: refusing a customer who wants to pay before
// scanning would decline money. The omission is deliberate.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStripe } from "@/lib/stripe";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { resolvePayIntentAttribution } from "@/lib/attribution";
import { PLAN_PRICES } from "@/lib/types";

// Closed enum of plan slugs derived from PLAN_PRICES at build time.
const PLAN_ENUM = z.enum(
  Object.keys(PLAN_PRICES) as [string, ...string[]],
);

// Stripe caps a metadata VALUE at 500 characters while GCLID_MAX_LENGTH (the
// zod bound, mirrored from /api/pay-intent) is 512. Writing an unclamped gclid
// would turn an over-long query string into a client-triggerable 500.
const STRIPE_METADATA_VALUE_MAX = 500;

export const checkoutSchema = z.object({
  plan: PLAN_ENUM,
  // Attribution the browser read at click time. Optional and untrusted - it is
  // only a FALLBACK for when the server-persisted user record is empty. Bounds
  // mirror /api/pay-intent so the two money-shaped routes agree.
  gclid: z.string().max(512).optional(),
  utm_campaign: z.string().max(128).optional(),
});
export type CheckoutResponse = { url: string };

export async function POST(request: Request) {
  // 1. Auth first.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit (after auth). Uses Upstash Redis in production (set
  //    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN); in-memory fallback
  //    in dev only - counters reset on cold start.
  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`checkout:${user.id}:${ip}`, 10, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // 3. REFUSE A SECOND SUBSCRIPTION. Nothing stopped an already-paying customer
  //    from buying again: the pricing page rendered "Choose Pro" regardless of
  //    status, and this route opened a session for anyone authenticated. The
  //    result is not a duplicate row but a duplicate CHARGE - Stripe happily
  //    holds two subscriptions for one customer, so they pay $120/month.
  //
  //    Worse, it goes unnoticed. The webhook upserts on user_id, so the row
  //    points at whichever subscription completed LAST; the first one keeps
  //    billing while being invisible to us, and cancelling in the portal ends
  //    only the one the customer happens to pick. This is not hypothetical - it
  //    happened to the test account (cus_VLbQli9C8FLAXX) during phase-3
  //    verification and made the cancellation events ambiguous.
  //
  //    SERVER-SIDE, not just the button. The UI change that accompanies this is
  //    what customers will see, but it can be walked around by a stale tab, a
  //    back button, or a direct POST. The charge has to be refused where the
  //    charge is created.
  //
  //    RLS scopes this read to the caller's own row, so no service-role client
  //    is needed and one user cannot probe another's subscription state.
  const { data: existing } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("user_id", user.id)
    .maybeSingle();

  // ACTIVE ONLY. A canceled row must still be able to buy again - that is a
  // returning customer, and the webhook's upsert is built to reuse their row.
  // A pending cancellation (status active, cancel_at_period_end true) is
  // deliberately refused too: they have paid for the current month and still
  // hold access, so a second purchase would bill them twice for the same
  // period. The portal's "Renew" is the correct route back, and the client
  // sends them there.
  if ((existing as { status?: string } | null)?.status === "active") {
    // Both `error` and `code`, matching the not_configured response below: the
    // shared client decision table (src/lib/checkout-client.ts) switches on
    // `code`, and dropping it here would fall through to the generic "could not
    // start checkout" message - which reads as a fault and invites a retry that
    // will also be refused.
    return NextResponse.json(
      {
        error: "already_subscribed",
        code: "already_subscribed",
        message:
          "You are already on Pro. Manage or cancel your plan from your dashboard.",
      },
      { status: 409 },
    );
  }

  try {
    const body = await request.json();
    const { plan, gclid, utm_campaign } = checkoutSchema.parse(body);

    // Bug #2: graceful "Pro upgrade coming soon" path. When Stripe envs are
    // unwired (e.g., a staging deployment or pre-launch demo without billing),
    // the route used to fall through to a generic 500 which read as a transient
    // failure and burned the demand signal. Detect the not-configured state
    // explicitly and emit a distinguishable response so the client can swap the
    // CTA to an inline waitlist form. DEMO_MODE keeps the demo Stripe client
    // happy path intact for development + e2e.
    const demoMode = process.env.DEMO_MODE === "true";
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const priceId = process.env.STRIPE_PRO_PRICE_ID;
    // Recognize the canonical placeholder shapes: empty, "placeholder-..."
    // (used by the demo Supabase client + tests), and the literals shipped in
    // .env.example. A real Stripe key is much longer than 16 chars, so the
    // length floor catches truncated/example values.
    const keyNotConfigured =
      !stripeKey ||
      stripeKey.startsWith("placeholder") ||
      stripeKey === "sk_test_..." ||
      stripeKey === "sk_live_..." ||
      stripeKey.length < 16;
    // Phase 3 adds a second required env: the dashboard Price. CI only ever
    // supplies placeholder Stripe values and cannot be given new env vars, so
    // every CI run terminates safely in this branch rather than reaching Stripe.
    const priceNotConfigured =
      !priceId ||
      priceId.startsWith("placeholder") ||
      priceId === "price_..." ||
      priceId.length < 8;
    // SAFETY INTERLOCK (deliberate, temporary): refuse to run against a LIVE
    // key. This PR ships a subscription with no self-serve cancellation path
    // and no billing legal pages, so it must be incapable of taking real money
    // even if a live key reaches the environment by accident. PR 2 adds the
    // cancellation route + legal pages and removes this branch; until then a
    // live key reads as "not configured".
    // ALLOWLIST, not a denylist: Stripe restricted live keys begin "rk_live_",
    // which a "sk_live_" prefix check would miss entirely. Anything that is not
    // a recognised TEST key is treated as not configured.
    const liveKeyInterlock =
      !!stripeKey &&
      !(stripeKey.startsWith("sk_test_") || stripeKey.startsWith("rk_test_"));
    const stripeNotConfigured =
      !demoMode && (keyNotConfigured || priceNotConfigured || liveKeyInterlock);
    if (stripeNotConfigured) {
      return NextResponse.json(
        {
          error: "not_configured",
          code: "not_configured",
          message:
            "Pro upgrade is coming soon. Join the waitlist to be notified.",
        },
        { status: 503 },
      );
    }

    // Server-authoritative price lookup - NEVER trust client-supplied amounts.
    const amount_cents = PLAN_PRICES[plan];
    if (typeof amount_cents !== "number" || amount_cents <= 0) {
      console.error("[checkout] PLAN_PRICES misconfigured for plan:", plan);
      return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
    }

    // priceId is guaranteed non-empty on the live path by the guard above. The
    // fallback only applies in DEMO_MODE, where the demo Stripe client ignores
    // line_items entirely.
    const linePriceId = priceId ?? "price_demo_placeholder";

    // The cadence Stripe will actually bill on, recorded so the subscriptions
    // row can state it (009_subscription_interval_period_end.sql). Relayed to
    // the webhook through the metadata bag below rather than re-fetched there,
    // so the value the database records is the one this route validated.
    //
    // Seeded with the plan as sold because DEMO_MODE has no Price catalogue to
    // read. On the live path the retrieved Price overwrites it, so a real
    // purchase never records a hardcoded assumption.
    let billingInterval = "month";

    // Validate the dashboard Price BEFORE opening a session. The Stripe account
    // bills in SGD and experiment/ads.yaml records a prior USD/SGD mix-up: a
    // Price whose currency, amount or interval disagrees with PLAN_PRICES would
    // charge one figure while our metadata (and every downstream revenue
    // calculation) recorded another. Refuse rather than reconcile later.
    // Skipped in DEMO_MODE - the demo Stripe client has no Price catalogue.
    if (!demoMode) {
      const price = await getStripe().prices.retrieve(linePriceId);
      const mismatch =
        price.unit_amount !== amount_cents ||
        price.currency !== "usd" ||
        price.recurring?.interval !== "month" ||
        (price.recurring?.interval_count ?? 1) !== 1 ||
        price.active !== true ||
        price.type !== "recurring";
      if (mismatch) {
        console.error(
          "[checkout] STRIPE_PRO_PRICE_ID disagrees with PLAN_PRICES:",
          {
            price_id: linePriceId,
            expected: { unit_amount: amount_cents, currency: "usd", interval: "month" },
            actual: {
              unit_amount: price.unit_amount,
              currency: price.currency,
              interval: price.recurring?.interval ?? null,
            },
          },
        );
        return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
      }

      // Safe to record only after the guard above, which has already refused
      // any Price that is not a single month. Read from the Price rather than
      // left at the seeded literal so the recorded cadence follows the Price if
      // PLAN_PRICES and the dashboard ever move together to another interval.
      billingInterval = price.recurring?.interval ?? billingInterval;
    }

    // Resolve attribution: the acquisition_* values stamped onto the user record
    // at signup win; the client read is the fallback. Same precedence function
    // as /api/pay-intent so the two money-shaped routes cannot drift.
    const attribution = resolvePayIntentAttribution(
      user.user_metadata as Record<string, unknown> | null,
      { gclid, utm_campaign },
    );

    // Stripe does NOT propagate Checkout Session metadata to the Subscription
    // object, and the PR 2 retention handlers (customer.subscription.deleted,
    // invoice.payment_failed) only ever see the Subscription. Both bags carry
    // the same payload so either arrival point can attribute the event.
    const metadata = {
      user_id: user.id,
      plan,
      amount_cents: String(amount_cents),
      gclid: (attribution.gclid ?? "").slice(0, STRIPE_METADATA_VALUE_MAX),
      utm_campaign: attribution.utm_campaign ?? "",
      attribution_source: attribution.source,
      // The billing cadence, so the webhook can persist it at
      // checkout.session.completed without a second Price round-trip. It rides
      // the same dual bag as everything else here because Stripe does not copy
      // Session metadata onto the Subscription.
      billing_interval: billingInterval,
    };

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: linePriceId, quantity: 1 }],
      metadata,
      subscription_data: { metadata },
      // Successful checkout returns the user to the dashboard so their new
      // quota is reflected immediately. Cancel routes back to /pricing.
      success_url: `${siteUrl}/dashboard?checkout=success`,
      cancel_url: `${siteUrl}/pricing?checkout=cancelled`,
    });

    if (!session.url) {
      console.error("[checkout] Stripe returned a session without a URL");
      return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
    }

    const response: CheckoutResponse = { url: session.url };
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    console.error("[checkout] unhandled error:", error);
    return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
  }
}
