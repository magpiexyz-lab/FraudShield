// POST /api/enterprise-lead — capture an Enterprise tier enquiry.
//
// Enterprise is negotiated rather than bought, so this records the qualifying
// answers instead of taking a payment. No charge, no payment provider import.
//
// Security:
//   - Authenticated via Supabase cookie session (401 otherwise). /pricing is
//     behind the auth middleware, so an anonymous caller is always illegitimate
//   - Rate-limited per user+IP after auth
//   - Body is zod-validated with explicit .max() bounds on every string
//   - Email is never accepted from the client — it is already on the user
//     record, and taking it from the body would let a lead be filed under
//     someone else's address
//   - Inserted with the service-role client because enterprise_leads has no
//     client write policy

import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";

// Coarse bands, not a free-text number: nobody knows their exact monthly
// volume, and a band separates a 50-document reviewer from a 5,000 well enough
// to route the conversation.
export const VOLUME_BANDS = [
  "under-100",
  "100-500",
  "500-2000",
  "over-2000",
] as const;

export const enterpriseLeadSchema = z.object({
  company: z.string().max(120).optional(),
  monthly_volume: z.enum(VOLUME_BANDS).optional(),
  message: z.string().max(2000).optional(),
});

export type EnterpriseLeadResponse = { ok: true };

export async function POST(request: Request) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`enterprise-lead:${user.id}:${ip}`, 5, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  try {
    const body = await request.json();
    const { company, monthly_volume, message } = enterpriseLeadSchema.parse(body);

    // An enquiry with nothing in it is not a lead. Cheap guard against an
    // accidental empty submit filling the pipeline with blanks.
    if (!company && !monthly_volume && !message) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const admin = createServiceRoleClient();
    const { error } = await admin.from("enterprise_leads").insert({
      user_id: user.id,
      company: company ?? null,
      monthly_volume: monthly_volume ?? null,
      message: message ?? null,
    });

    if (error) {
      // Log raw server-side, return generic to the client.
      console.error("[enterprise-lead] insert error:", error);
      return NextResponse.json({ error: "Failed to send enquiry" }, { status: 500 });
    }

    const response: EnterpriseLeadResponse = { ok: true };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    console.error("[enterprise-lead] unhandled error:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
