// POST /api/webhooks/stripe — Stripe webhook handler (b-07 system actor).
//
// Verifies the raw request body via STRIPE_WEBHOOK_SECRET, then handles
// `checkout.session.completed` by upserting the user's subscription to
// status='active' + their paid plan. Idempotent via the stripe_events table
// (INSERT + catch PG 23505 — atomic at the DB level).
//
// NO rate limiting — Stripe retries delivery on failure; a rate limiter
// would silently drop legitimate retries. The signature verify is the
// cryptographic boundary.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { trackServerEvent } from "@/lib/analytics-server";
import { PLAN_PRICES, PRO_SCAN_QUOTA } from "@/lib/types";

// Paid subscriptions raise scan quota above the free allowance. Sourced from
// PRO_SCAN_QUOTA rather than restated: this held 9999 ("effectively unlimited")
// after the plan moved to a 200/month cap, so an actual subscriber would have
// been granted 50x what the pricing page sells them.
const PLAN_SCAN_QUOTA: Record<string, number> = {
  pro: PRO_SCAN_QUOTA,
};

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("[webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Idempotency guard — INSERT + catch PG 23505. Atomic per the PRIMARY KEY
  // on stripe_event_id. Two concurrent deliveries: exactly one INSERT
  // succeeds; the other gets 23505 and we return 200 to suppress retries.
  const supabase = createServiceRoleClient();
  const { error: insertErr } = await supabase
    .from("stripe_events")
    .insert({ stripe_event_id: event.id });
  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      return NextResponse.json({ received: true });
    }
    console.error("[webhook] stripe_events insert error:", insertErr);
    return NextResponse.json(
      { error: "Persistence error" },
      { status: 500 },
    );
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id ?? "";
    const plan = session.metadata?.plan ?? "";
    const amountCents = Number(session.metadata?.amount_cents ?? 0);

    // NEVER resolve user identity via session.customer_email — that field is
    // attacker-controllable. The user_id metadata was set server-side at
    // checkout creation by an authenticated route, so it is trustworthy.
    if (!userId) {
      console.error("[webhook] missing user_id in session metadata", session.id);
      return NextResponse.json({ received: true });
    }

    const planQuota =
      typeof PLAN_SCAN_QUOTA[plan] === "number" ? PLAN_SCAN_QUOTA[plan] : 100;
    const planAmount =
      amountCents > 0
        ? amountCents
        : (typeof PLAN_PRICES[plan] === "number" ? PLAN_PRICES[plan] : 0);

    const { error: upsertErr } = await supabase.from("subscriptions").upsert(
      {
        user_id: userId,
        status: "active",
        plan,
        scan_quota: planQuota,
        // Billing anchor for the monthly scan quota. Checkout completing IS the
        // start of the first period; the scan route rolls this forward in whole
        // months, so quota resets correctly without depending on a renewal
        // webhook having fired. See 007_subscription_period.sql.
        current_period_start: new Date().toISOString(),
        stripe_customer_id:
          typeof session.customer === "string" ? session.customer : null,
        stripe_subscription_id:
          typeof session.subscription === "string" ? session.subscription : null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (upsertErr) {
      console.error("[webhook] subscriptions upsert error:", upsertErr);
      return NextResponse.json(
        { error: "Persistence error" },
        { status: 500 },
      );
    }

    await trackServerEvent("pay_success", userId, {
      plan,
      amount_cents: planAmount,
      amount: planAmount,
      provider: "stripe",
    });
  }

  // Cancellation. Fires when a subscription actually ends - immediately, or at
  // period end once a customer cancels in the Billing Portal. Without this the
  // app would keep a cancelled customer on Pro forever, because nothing else
  // ever writes status away from "active".
  //
  // Identity comes from stripe_subscription_id, NOT metadata: this event carries
  // a Subscription object, which has no session metadata. That column is unique
  // (001_initial.sql), and it is populated from session.subscription at checkout
  // - a string only in subscription mode, which is why cancellation could not
  // have been wired while the plan was a one-off payment.
  //
  // computeQuota gates on status === "active", so flipping the status is all
  // that is needed to drop the user back to the free allowance. No quota write,
  // no second source of truth.
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;

    const { error: cancelErr } = await supabase
      .from("subscriptions")
      .update({
        status: "canceled",
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscription.id);

    if (cancelErr) {
      console.error("[webhook] subscription cancel update error:", cancelErr);
      return NextResponse.json(
        { error: "Persistence error" },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ received: true });
}
