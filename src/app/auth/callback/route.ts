// /auth/callback — PKCE code exchange for email confirmation, OAuth, magic
// link, and password reset flows. Forwards an authenticated user to the
// `next` parameter (validated against open-redirect — `/` + reject `//`).
//
// Also fires server-side signup_complete for OAuth/email-confirm/magic-link
// signups via the recency filter (user.created_at < 60s). This is the shared
// chokepoint that the client-side trackSignupComplete cannot cover.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { trackServerEvent } from "@/lib/analytics-server";

const codeSchema = z
  .string()
  .min(20)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

const SIGNUP_RECENCY_MS = 60_000;

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") {
    return NextResponse.redirect(`${origin}/`);
  }

  // OAuth providers can redirect back with ?error=... — forward verbatim so
  // /login can render a provider-specific recovery banner.
  const errorParam = searchParams.get("error");
  if (errorParam) {
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(errorParam)}`,
    );
  }

  const rawCode = searchParams.get("code");
  const rawNext = searchParams.get("next") ?? "/";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const parsedCode = rawCode ? codeSchema.safeParse(rawCode) : null;
  if (parsedCode?.success) {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.exchangeCodeForSession(
      parsedCode.data,
    );
    if (!error) {
      const { data: { user } } = await supabase.auth.getUser();
      if (
        user &&
        Date.now() - new Date(user.created_at).getTime() < SIGNUP_RECENCY_MS
      ) {
        const provider =
          (user.app_metadata?.provider as string | undefined) ?? "email";
        await trackServerEvent("signup_complete", user.id, { provider });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
