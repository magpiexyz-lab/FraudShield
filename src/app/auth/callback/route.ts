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
  ACQUISITION_GCLID_KEY,
  ACQUISITION_UTM_CAMPAIGN_KEY,
  ATTRIBUTION_COOKIE,
  LAST_TOUCH_GCLID_KEY,
  LAST_TOUCH_UTM_CAMPAIGN_KEY,
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
        await onAuthenticated(supabase, undefined, attribution);
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
        await onAuthenticated(supabase, undefined, attribution);
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
    await onAuthenticated(supabase, user, attribution);
    return redirectInto(next);
  }

  // ── Path 4: No code, no token_hash, no session — true failure. ───────
  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("missing_or_expired_link")}`,
  );
}

/**
 * Runs after any successful authentication through this route — OAuth, magic
 * link, email confirmation, or password recovery.
 *
 * Two jobs with deliberately different conditions:
 *
 *   1. Persist attribution — ALWAYS. This is the fix for the known Phase-2
 *      measurement gap: attribution used to be written only inside the fresh-
 *      signup branch, so a returning user who clicked a paid ad and logged in
 *      never had that touch recorded. Their click counted in the verdict's
 *      denominator while their pay_intent, still carrying the older campaign,
 *      was dropped from the numerator as unattributed.
 *   2. Fire signup_complete — only for accounts created within
 *      SIGNUP_RECENCY_MS. Shared chokepoint the client-side trackSignupComplete
 *      cannot cover for email-confirm / OAuth / magic-link.
 *
 * Pass `userOverride` to avoid a second getUser() round-trip when the caller
 * already has the user object.
 */
async function onAuthenticated(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  userOverride?: { id: string; created_at: string; app_metadata?: { provider?: string } } | null,
  attribution: Attribution = {},
) {
  try {
    const user = userOverride ?? (await supabase.auth.getUser()).data.user;
    if (!user) return;

    await persistAttribution(user.id, attribution);

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
  } catch {
    // Never let analytics fire interfere with the auth redirect.
  }
}

/**
 * Stamps the attribution for this visit onto the user record so it outlives the
 * PostHog event stream — needed to answer "which campaign produced the customers
 * who converted?" months later, after session data is long gone.
 *
 * Stored in auth.users.user_metadata (there is no profiles table) via the
 * service-role client, under two pairs with different overwrite rules:
 *
 *   - acquisition_* — FIRST touch, written once. A later organic login must not
 *     overwrite the paid click that actually acquired the user.
 *   - last_touch_*  — rewritten whenever a visit arrives carrying attribution,
 *     so a returning user's new campaign is recorded without destroying the
 *     first-touch answer. This is what a phase-scoped ad test measures.
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

    const hasFirstTouch = Boolean(
      current[ACQUISITION_GCLID_KEY] || current[ACQUISITION_UTM_CAMPAIGN_KEY],
    );
    // Only fields actually present are compared: an attribution carrying just a
    // campaign must not be treated as "changed" because it has no gclid to match.
    const lastTouchUnchanged =
      (!attribution.gclid || current[LAST_TOUCH_GCLID_KEY] === attribution.gclid) &&
      (!attribution.utm_campaign ||
        current[LAST_TOUCH_UTM_CAMPAIGN_KEY] === attribution.utm_campaign);

    // This now runs on every authenticated callback, not just fresh signups, so
    // the common case is a repeat login with nothing new to record. Skip the
    // write rather than churning user_metadata on every visit.
    if (hasFirstTouch && lastTouchUnchanged) return;

    const recordedAt = new Date().toISOString();
    await admin.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...current,
        ...(hasFirstTouch
          ? {}
          : {
              ...(attribution.gclid
                ? { [ACQUISITION_GCLID_KEY]: attribution.gclid }
                : {}),
              ...(attribution.utm_campaign
                ? { [ACQUISITION_UTM_CAMPAIGN_KEY]: attribution.utm_campaign }
                : {}),
              acquisition_recorded_at: recordedAt,
            }),
        // Written unconditionally. Absent fields are left alone rather than
        // nulled — a campaign-only visit must not erase a previously recorded
        // gclid.
        ...(attribution.gclid ? { [LAST_TOUCH_GCLID_KEY]: attribution.gclid } : {}),
        ...(attribution.utm_campaign
          ? { [LAST_TOUCH_UTM_CAMPAIGN_KEY]: attribution.utm_campaign }
          : {}),
        last_touch_recorded_at: recordedAt,
      },
    });
  } catch {
    // Attribution persistence is best-effort — never block the auth redirect.
  }
}
