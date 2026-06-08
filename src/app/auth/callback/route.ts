// /auth/callback — handles every Supabase email/OAuth landing flow:
//   1. PKCE code exchange   (?code=...)      — exchangeCodeForSession
//   2. Token-hash verify    (?token_hash=... &type=signup|recovery|email_change|invite|magiclink)
//                                            — verifyOtp (modern Supabase templates)
//   3. Implicit/redirect    (no params, session already in cookies via /auth/v1/verify)
//                                            — getUser fallback
//   4. Real failure         (none of the above match) — /login?error=<reason>
//
// Also fires server-side signup_complete for fresh signups (user.created_at < 60s).
//
// Bug #5 + post-launch bug #4: previously this route required ?code to be
// present and fell through to /login?error=auth for the (2) token-hash and
// (3) implicit-flow shapes — which is exactly what users hit, because the
// default Supabase confirmation email routes through /auth/v1/verify and
// lands here with the session already set in cookies and NO ?code param.

import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { trackServerEvent } from "@/lib/analytics-server";

const codeSchema = z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/);
const tokenHashSchema = z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/);
const otpTypeSchema = z.enum([
  "signup",
  "recovery",
  "email_change",
  "invite",
  "magiclink",
]);

const SIGNUP_RECENCY_MS = 60_000;

/** Same-origin guard so `?next=//evil.com` cannot redirect off-site. */
function safeNext(raw: string | null, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") {
    return NextResponse.redirect(`${origin}/`);
  }

  // OAuth providers (and Supabase's verify endpoint on failure) redirect back
  // with ?error=...&error_description=... — forward verbatim so /login can
  // render a useful banner instead of a generic "Authentication failed."
  const errorParam = searchParams.get("error");
  if (errorParam) {
    const detail = searchParams.get("error_description") ?? errorParam;
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(detail).slice(0, 256)}`,
    );
  }

  const next = safeNext(searchParams.get("next"));
  const supabase = await createServerSupabaseClient();

  // ── Path 1: PKCE code exchange ────────────────────────────────────────
  const rawCode = searchParams.get("code");
  if (rawCode) {
    const parsed = codeSchema.safeParse(rawCode);
    if (parsed.success) {
      const { error } = await supabase.auth.exchangeCodeForSession(parsed.data);
      if (!error) {
        await maybeFireSignupComplete(supabase);
        return NextResponse.redirect(`${origin}${next}`);
      }
      return NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent("link_invalid_or_expired")}`,
      );
    }
  }

  // ── Path 2: Token-hash verify (modern Supabase email templates) ──────
  // Email templates that use `{{ .TokenHash }}` land here. Type identifies
  // the flow: signup | recovery | email_change | invite | magiclink.
  const rawTokenHash = searchParams.get("token_hash");
  const rawType = searchParams.get("type");
  if (rawTokenHash && rawType) {
    const parsedHash = tokenHashSchema.safeParse(rawTokenHash);
    const parsedType = otpTypeSchema.safeParse(rawType);
    if (parsedHash.success && parsedType.success) {
      const { error } = await supabase.auth.verifyOtp({
        token_hash: parsedHash.data,
        type: parsedType.data,
      });
      if (!error) {
        await maybeFireSignupComplete(supabase);
        return NextResponse.redirect(`${origin}${next}`);
      }
      return NextResponse.redirect(
        `${origin}/login?error=${encodeURIComponent("link_invalid_or_expired")}`,
      );
    }
  }

  // ── Path 3: Implicit/redirect — Supabase /auth/v1/verify already set ─
  // the session via cookies; we just need to redirect into the app. Default
  // Supabase email templates use ConfirmationURL which routes through this
  // implicit path (post-launch bug #4 root cause).
  const { data: { user } } = await supabase.auth.getUser();
  if (user) {
    await maybeFireSignupComplete(supabase, user);
    return NextResponse.redirect(`${origin}${next}`);
  }

  // ── Path 4: No code, no token_hash, no session — true failure. ───────
  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("missing_or_expired_link")}`,
  );
}

/**
 * Fires server-side signup_complete for fresh signups (created within the
 * last SIGNUP_RECENCY_MS). Shared chokepoint that the client-side
 * trackSignupComplete cannot cover for email-confirm / OAuth / magic-link.
 *
 * Pass `userOverride` to avoid a second getUser() round-trip when the caller
 * already has the user object.
 */
async function maybeFireSignupComplete(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  userOverride?: { id: string; created_at: string; app_metadata?: { provider?: string } } | null,
) {
  try {
    const user = userOverride ?? (await supabase.auth.getUser()).data.user;
    if (!user) return;
    if (Date.now() - new Date(user.created_at).getTime() >= SIGNUP_RECENCY_MS) {
      return;
    }
    const provider =
      (user.app_metadata?.provider as string | undefined) ?? "email";
    await trackServerEvent("signup_complete", user.id, { provider });
  } catch {
    // Never let analytics fire interfere with the auth redirect.
  }
}
