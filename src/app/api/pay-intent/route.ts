// POST /api/pay-intent — record a fake-door "Upgrade to Pro" click.
//
// Google Ads Phase 2 measures willingness to pay: of the users we paid to
// bring, how many take a money-shaped action. This route is the DB half of that
// signal (the PostHog event is the other half). NOTHING IS CHARGED and no
// payment provider is imported here — that is enforced by the P2-e static check,
// which walks this file's transitive imports looking for a payment SDK.
//
// Security:
//   - Authenticated via Supabase cookie session (401 otherwise)
//   - Rate-limited per user+IP after auth
//   - Body is zod-validated with explicit .max() bounds on every string
//   - price_cents is read SERVER-SIDE from PLAN_PRICES — the client never
//     supplies a price, so a forged body cannot corrupt the cross-MVP revenue
//     ranking that multiplies this value by the pay-intent rate
//   - Inserted with the service-role client because pay_intent has no client
//     write policy; a client-writable table would let anyone forge the rows the
//     verdict counts

import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { resolvePayIntentAttribution } from "@/lib/attribution";
import { PLAN_PRICES } from "@/lib/types";

// Closed enum derived from the price table at build time — same idiom as
// /api/checkout, so an unknown plan is rejected before it reaches the database.
const PLAN_ENUM = z.enum(Object.keys(PLAN_PRICES) as [string, ...string[]]);

export const payIntentSchema = z.object({
  plan: PLAN_ENUM,
  // Attribution the browser read at click time. Optional and untrusted: it is
  // only a FALLBACK for when the server-persisted user record is empty (organic
  // signups, and the day-0 probe whose gclid the strict sanitizer refuses).
  // resolvePayIntentAttribution decides precedence and records which source won.
  gclid: z.string().max(512).optional(),
  utm_campaign: z.string().max(128).optional(),
  distinct_id: z.string().max(200).optional(),
});

export type PayIntentResponse = { ok: true };

export async function POST(request: Request) {
  // 1. Auth first — the CTA is activation-gated, so an anonymous caller is
  //    always illegitimate.
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit (after auth), keyed per user and IP like /api/checkout.
  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`pay-intent:${user.id}:${ip}`, 10, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { plan, gclid, utm_campaign, distinct_id } = payIntentSchema.parse(body);

    // 3. Server-authoritative price. NEVER trust a client-supplied amount.
    const price_cents = PLAN_PRICES[plan];

    // 4. Resolve attribution: the acquisition_* values stamped onto the user
    //    record at signup win; the client read is the fallback.
    const attribution = resolvePayIntentAttribution(
      user.user_metadata as Record<string, unknown> | null,
      { gclid, utm_campaign },
    );

    const admin = createServiceRoleClient();
    const { error } = await admin.from("pay_intent").insert({
      user_id: user.id,
      distinct_id: distinct_id ?? null,
      gclid: attribution.gclid ?? null,
      utm_campaign: attribution.utm_campaign ?? null,
      attribution_source: attribution.source,
      price_cents,
    });

    if (error) {
      // Log raw server-side, return generic to the client — never leak the
      // database error text.
      console.error("[pay-intent] insert error:", error);
      return NextResponse.json({ error: "Failed to record interest" }, { status: 500 });
    }

    const response: PayIntentResponse = { ok: true };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    console.error("[pay-intent] unhandled error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
