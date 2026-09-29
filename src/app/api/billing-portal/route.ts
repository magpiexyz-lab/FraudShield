// POST /api/billing-portal - open the Stripe Billing Portal so a subscriber can
// cancel, update their card, or read invoices.
//
// This exists because the checkout page tells the customer "you authorize
// Draft Labs to charge you according to the terms until you cancel", and the ad
// copy promises "Cancel anytime". Shipping recurring billing with no way to
// cancel would make both statements false. Stripe hosts the portal, so
// cancellation, proration and invoice history are handled there rather than
// reimplemented here.
//
// Security mirrors /api/checkout:
//   - Authenticated via the Supabase cookie session (401 otherwise)
//   - Rate-limited per user+IP AFTER auth
//   - The Stripe customer id is read from the user OWN subscriptions row via
//     the cookie-scoped client, so RLS (subscriptions_select_own) guarantees a
//     caller can only ever open a portal for themselves. The id is never
//     accepted from the request body.

import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";

export type BillingPortalResponse = { url: string };

export async function POST(request: Request) {
  // 1. Auth first.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit after auth, same shape as /api/checkout.
  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`portal:${user.id}:${ip}`, 10, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  try {
    // 3. Resolve the Stripe customer from the caller OWN row. RLS scopes this
    //    to the authenticated user, so no id can be supplied by the client.
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("stripe_customer_id, status")
      .eq("user_id", user.id)
      .maybeSingle();

    const customerId = (sub as { stripe_customer_id?: string | null } | null)
      ?.stripe_customer_id;

    if (!customerId) {
      // Never subscribed, or a comped grant with no Stripe customer. There is
      // nothing to manage - say so plainly rather than opening an empty portal.
      return NextResponse.json(
        {
          error: "no_subscription",
          code: "no_subscription",
          message: "You do not have a billing subscription to manage.",
        },
        { status: 404 },
      );
    }

    // 4. DEMO_MODE short-circuit. The demo Stripe client implements only
    //    checkout.sessions and webhooks, so calling billingPortal on it would
    //    throw. Return a benign round-trip URL to keep local and e2e flows
    //    working without pretending a portal was opened.
    if (process.env.DEMO_MODE === "true") {
      return NextResponse.json({ url: `${siteUrl}/dashboard?billing=demo` });
    }

    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${siteUrl}/dashboard`,
    });

    if (!session.url) {
      console.error("[billing-portal] Stripe returned a session without a URL");
      return NextResponse.json(
        { error: "Could not open billing portal" },
        { status: 500 },
      );
    }

    const response: BillingPortalResponse = { url: session.url };
    return NextResponse.json(response);
  } catch (error) {
    // Log server-side, return generic to the client - never leak Stripe error
    // text. The most common real cause is the Billing Portal not being
    // activated in the Stripe dashboard (Settings -> Billing -> Customer
    // portal), which surfaces here as an invalid_request_error.
    console.error("[billing-portal] unhandled error:", error);
    return NextResponse.json(
      { error: "Could not open billing portal" },
      { status: 500 },
    );
  }
}
