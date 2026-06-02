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
import { PLAN_PRICES } from "@/lib/types";

// Paid subscriptions raise scan quota well above the free allowance.
// Adjust per-plan if/when more tiers are added.
const PLAN_SCAN_QUOTA: Record<string, number> = {
  pro: 9999, // effectively unlimited within billing period
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

  return NextResponse.json({ received: true });
}
