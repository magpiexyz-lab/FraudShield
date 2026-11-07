// POST /api/waitlist — capture B2B "Get API access" fake-door interest (b-05).
//
// Anonymous users may also submit (user_id stays null), so this route does
// NOT require an authenticated session. We service-role-insert so the row
// is written even when there's no Supabase cookie. We still rate-limit by IP.
//
// Security:
//   - Zod-validated email (length-capped)
//   - Per-IP rate limit (burst protection only — in-memory)
//   - Generic { error } shape; raw Postgres errors logged server-side only

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createServerSupabaseClient,
  createServiceRoleClient,
} from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { VOLUME_BANDS } from "@/lib/volume-bands";

// The three request-form fields are OPTIONAL at the schema level even though
// the dialog asks for all of them. Two reasons: the pro-upgrade source posts
// email alone and must keep working, and a visitor who fills in three of four
// fields should not have their interest thrown away over the fourth. The form
// asks; the route records whatever arrives.
//
// monthly_volume reuses VOLUME_BANDS from the enterprise-lead route rather
// than redeclaring the scale, so the two intake surfaces cannot drift apart
// and a single query can read both.
export const waitlistSchema = z.object({
  email: z.email().max(254),
  source: z.string().max(64).optional(),
  company: z.string().max(120).optional(),
  role: z.string().max(120).optional(),
  monthly_volume: z.enum(VOLUME_BANDS).optional(),
});
export type WaitlistResponse = { ok: true };

export async function POST(request: Request) {
  // Rate-limit first — anonymous endpoint, no auth-based key. Uses Upstash
  // Redis in production (set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN);
  // in-memory fallback in dev only.
  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`waitlist:${ip}`, 5, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { email, source, company, role, monthly_volume } =
      waitlistSchema.parse(body);

    // Try to attach the authenticated user when present, but anonymous
    // submissions are explicitly allowed (b-05 fake-door surface).
    let userId: string | null = null;
    try {
      const cookieClient = await createServerSupabaseClient();
      const { data: { user } } = await cookieClient.auth.getUser();
      userId = user?.id ?? null;
    } catch {
      userId = null;
    }

    // Service-role insert — RLS on api_waitlist allows anon INSERT only with
    // user_id = auth.uid() OR NULL, but using the service role here keeps the
    // semantics consistent whether or not the caller is signed in.
    // Bug #2: persist the `source` field so we can segment the b-05 API-access
    // demand signal from the Pro-upgrade waitlist demand signal (source:
    // "pro-upgrade") added when Stripe envs are placeholders.
    const supabase = createServiceRoleClient();
    const { error } = await supabase.from("api_waitlist").insert({
      user_id: userId,
      email,
      ...(source ? { source } : {}),
      // Spread-when-present, matching how source is handled above: a field the
      // caller omitted stays absent from the insert rather than being written
      // as an empty string, so "not asked" and "asked, left blank" do not
      // collapse into the same stored value.
      ...(company ? { company } : {}),
      ...(role ? { role } : {}),
      ...(monthly_volume ? { monthly_volume } : {}),
    });

    if (error) {
      console.error("[waitlist] insert error:", error);
      return NextResponse.json(
        { error: "Failed to join waitlist" },
        { status: 500 },
      );
    }

    const response: WaitlistResponse = { ok: true };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    console.error("[waitlist] unhandled error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
