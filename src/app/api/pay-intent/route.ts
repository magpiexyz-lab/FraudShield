// POST /api/pay-intent — RETAINED FOR HISTORICAL MEASUREMENT ONLY.
//
// This route recorded the Phase 2 fake-door "Upgrade to Pro" click. Phase 3
// replaced that fake door with a real Stripe subscription, so NOTHING IN THE
// PRODUCT CALLS THIS ROUTE ANY MORE: the pricing page and the scan-result CTA
// both POST /api/checkout now.
//
// It stays live, along with public.pay_intent and every row in it, for two
// reasons. The cross-MVP verdict pipeline reads that table, and the Phase 2
// rows are the ground truth the willingness-to-pay verdict was written
// against. Removing either would silently rewrite a finished experiment.
//
// DO NOT WIRE THIS TO ANY NEW UI. A click here is not a purchase, and mixing
// fake-door rows into Phase 3 subscription data would corrupt both numbers.
// New money-shaped surfaces belong on /api/checkout.
//
// Security (unchanged - the route is still reachable and still authenticated):
//   - Authenticated via Supabase cookie session (401 otherwise)
//   - Rate-limited per user+IP after auth
//   - Body is zod-validated with explicit .max() bounds on every string
//   - price_cents is read SERVER-SIDE from PLAN_PRICES — the client never
//     supplies a price, so a forged body cannot corrupt the cross-MVP revenue
//     ranking that multiplies this value by the pay-intent rate
//   - Inserted with the service-role client because pay_intent has no client
//     write policy; a client-writable table would let anyone forge the rows the
//     verdict counts
//   - NOTHING IS CHARGED and no payment provider is imported here — enforced by
//     the P2-e static check, which walks the transitive imports of this file

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

    // 3. Activation gate, enforced HERE rather than only in the UI.
    //
    // Phase 2 measures whether people who USED the product will pay for it. A
    // signed-up user who never received a fraud score has no idea what they
    // would be buying, so counting their click would measure curiosity instead
    // of value and inflate the numerator. Every surface render-guards the CTA,
    // but a client guard is cosmetic — this check is what makes the gate hold,
    // and it keeps the rule in one place now that the offer appears on both
    // /scan-result and /pricing.
    //
    // Deliberately placed after zod parsing rather than before: a malformed body
    // should still answer 400 rather than 403, so the validation contract stays
    // observable. Auth and rate limiting already ran above.
    const { count: scanCount, error: scanCountError } = await supabase
      .from("scans")
      .select("id", { count: "exact", head: true });
    if (scanCountError) {
      console.error("[pay-intent] activation lookup error:", scanCountError);
      return NextResponse.json({ error: "Failed to record interest" }, { status: 500 });
    }
    if (!scanCount || scanCount < 1) {
      return NextResponse.json({ error: "Not activated" }, { status: 403 });
    }

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
