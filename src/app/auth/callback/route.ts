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
import { cookies } from "next/headers";
import { z } from "zod";
import { createServerSupabaseClient, createServiceRoleClient } from "@/lib/supabase-server";
import { trackServerEvent } from "@/lib/analytics-server";
import {
  ATTRIBUTION_COOKIE,
  appendAttributionToPath,
  hasAttribution,
  resolveRelayedAttribution,
  type Attribution,
} from "@/lib/attribution";

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

  // Paid-attribution relay. The OAuth hop through Google destroys client state,
  // and this route fires signup_complete SERVER-side where sessionStorage does
  // not exist — so the click ids ride back on the redirectTo query params, with
  // the __fs_attr cookie as fallback for allow-lists that strip unknown params.
  let relayCookie: string | null = null;
  try {
    relayCookie = (await cookies()).get(ATTRIBUTION_COOKIE)?.value ?? null;
  } catch {
    // cookies() throws outside a request scope (tests invoke GET directly).
    // The query-param relay still works; only the cookie fallback is lost.
  }
  const attribution = resolveRelayedAttribution(
    {
      gclid: searchParams.get("gclid"),
      utm_campaign: searchParams.get("utm_campaign"),
    },
    relayCookie,
  );

  /**
   * Redirects into the app, re-appending attribution to the destination so the
   * pre-hydration capture script in layout.tsx can re-arm sessionStorage, and
   * clearing the relay cookie now that it has been consumed.
   */
  const redirectInto = (destination: string) => {
    const response = NextResponse.redirect(
      `${origin}${appendAttributionToPath(destination, attribution)}`,
    );
    if (hasAttribution(attribution)) response.cookies.delete(ATTRIBUTION_COOKIE);
    return response;
  };

  const supabase = await createServerSupabaseClient();

  // ── Path 1: PKCE code exchange ────────────────────────────────────────
  const rawCode = searchParams.get("code");
  if (rawCode) {
    const parsed = codeSchema.safeParse(rawCode);
    if (parsed.success) {
      const { error } = await supabase.auth.exchangeCodeForSession(parsed.data);
      if (!error) {
        await maybeFireSignupComplete(supabase, undefined, attribution);
        return redirectInto(next);
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
        await maybeFireSignupComplete(supabase, undefined, attribution);
        return redirectInto(next);
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
    await maybeFireSignupComplete(supabase, user, attribution);
    return redirectInto(next);
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
  attribution: Attribution = {},
) {
  try {
    const user = userOverride ?? (await supabase.auth.getUser()).data.user;
    if (!user) return;
    if (Date.now() - new Date(user.created_at).getTime() >= SIGNUP_RECENCY_MS) {
      return;
    }
    const provider =
      (user.app_metadata?.provider as string | undefined) ?? "email";
    // Spreading a sanitized object keeps absent values off the payload entirely
    // rather than sending gclid: undefined.
    await trackServerEvent("signup_complete", user.id, {
      provider,
      method: provider === "google" ? "google" : "email",
      ...attribution,
    });
    await persistAttribution(user.id, attribution);
  } catch {
    // Never let analytics fire interfere with the auth redirect.
  }
}

/**
 * Stamps the acquisition source onto the user record so attribution outlives
 * the PostHog event stream — needed to answer "which campaign produced the
 * customers who converted?" months later, after session data is long gone.
 *
 * Stored in auth.users.user_metadata (there is no profiles table) via the
 * service-role client, and written once: the FIRST touch wins, so a later
 * organic login cannot overwrite the paid click that actually acquired them.
 */
async function persistAttribution(userId: string, attribution: Attribution) {
  if (!hasAttribution(attribution)) return;
  try {
    const admin = createServiceRoleClient();
    // The demo client proxies unknown auth members to a bare function, so
    // admin.updateUserById is undefined under DEMO_MODE — guard rather than throw.
    if (typeof admin.auth?.admin?.updateUserById !== "function") return;
    if (typeof admin.auth?.admin?.getUserById !== "function") return;

    const { data: existing } = await admin.auth.admin.getUserById(userId);
    const current = (existing?.user?.user_metadata ?? {}) as Record<string, unknown>;
    if (current.acquisition_gclid || current.acquisition_utm_campaign) return;

    await admin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...current,
        ...(attribution.gclid ? { acquisition_gclid: attribution.gclid } : {}),
        ...(attribution.utm_campaign
          ? { acquisition_utm_campaign: attribution.utm_campaign }
          : {}),
        acquisition_recorded_at: new Date().toISOString(),
      },
    });
  } catch {
    // Attribution persistence is best-effort — never block the auth redirect.
  }
}
