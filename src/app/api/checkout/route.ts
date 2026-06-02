// POST /api/checkout — create a Stripe Checkout Session for the chosen plan.
//
// Security:
//   - Authenticated via Supabase cookie session
//   - Rate-limited (after auth) per IP — burst protection on Vercel
//   - Plan price is read SERVER-SIDE from PLAN_PRICES — the client never
//     supplies a price. Plan slug is validated against a closed enum.
//   - Stripe metadata carries user_id + plan + amount_cents so the webhook
//     handler can mark the subscription active.

import { NextResponse } from "next/server";
import { z } from "zod";
import { getStripe } from "@/lib/stripe";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { PLAN_PRICES } from "@/lib/types";

// Closed enum of plan slugs derived from PLAN_PRICES at build time.
const PLAN_ENUM = z.enum(
  Object.keys(PLAN_PRICES) as [string, ...string[]],
);

export const checkoutSchema = z.object({
  plan: PLAN_ENUM,
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
  //    in dev only — counters reset on cold start.
  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`checkout:${user.id}:${ip}`, 10, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { plan } = checkoutSchema.parse(body);

    // Server-authoritative price lookup — NEVER trust client-supplied amounts.
    const amount_cents = PLAN_PRICES[plan];
    if (typeof amount_cents !== "number" || amount_cents <= 0) {
      console.error("[checkout] PLAN_PRICES misconfigured for plan:", plan);
      return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
    }

    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: `FraudShield ${plan}` },
            unit_amount: amount_cents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        user_id: user.id,
        plan,
        amount_cents: String(amount_cents),
      },
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
