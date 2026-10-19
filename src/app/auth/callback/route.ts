// /auth/callback — handles every Supabase email/OAuth landing flow:
//   1. PKCE code exchange   (?code=...)      — exchangeCodeForSession
//   2. Token-hash verify    (?token_hash=... &type=signup|recovery|email_change|invite|magiclink)
//                                            — verifyOtp (modern Supabase templates)
//   3. Session already set  (implicit/redirect flow, OR a spent token on an
//                              account that is already confirmed)
//                                            — getUser fallback
//   4. Real failure         (no session and nothing above matched)
//                                            — /login?error=<reason>
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
import { safeInternalPath } from "@/lib/safe-redirect";

const codeSchema = z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/);
const tokenHashSchema = z.string().min(20).max(512).regex(/^[A-Za-z0-9_-]+$/);
const otpTypeSchema = z.enum([
  "signup",
  "recovery",
  "email_change",
  "invite",
  "magiclink",
]);

/**
 * Key on the user's app_metadata marking that signup_complete has been sent.
 *
 * app_metadata, NOT user_metadata, and the difference matters: user_metadata is
 * writable by the user's own session, so a flag kept there could be cleared
 * from the browser and the event re-fired. app_metadata is service-role only.
 * (persistAttribution writes to user_metadata because an attribution value is
 * descriptive; this one is a ledger entry.)
 *
 * Stores a timestamp rather than `true` -- same cost, and it answers "when was
 * this account first seen" later on.
 */
const SIGNUP_COMPLETE_KEY = "signup_complete_fired_at";

/**
 * Accounts created before this instant are grandfathered: flagged on sight,
 * never announced.
 *
 * Without it every existing customer fires signup_complete the next time they
 * sign in -- they have no flag, so first sight looks exactly like a new
 * account. That would report the entire userbase as signing up again on the
 * day this deployed.
 *
 * A fixed instant rather than a rolling window on purpose. It is a one-time
 * boundary between "before the flag existed" and after, not a rule about how
 * fresh a signup has to be, and it stops mattering once every active account
 * carries a flag.
 */
const SIGNUP_FLAG_EPOCH_MS = Date.parse("2026-10-19T00:00:00Z");

/**
 * Same-origin guard for `?next=`, delegating to the shared predicate in
 * src/lib/safe-redirect.ts.
 *
 * This route is not exploitable the way /login was -- redirectInto concatenates
 * onto `origin`, so the URL is parsed as absolute and a backslash stays inside
 * the path -- but it carried a verbatim copy of the guard that WAS exploitable,
 * and one refactor of redirectInto would have made it live. The two copies
 * drifting apart is the root cause, so there is now only one.
 */
function safeNext(raw: string | null, fallback = "/dashboard"): string {
  return safeInternalPath(raw, fallback);
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
      // A FAILED EXCHANGE IS NOT YET A FAILED SIGNUP. Fall through to the
      // session check below rather than erroring here -- see the note on
      // Path 3. A link whose token has already been spent can still belong to
      // an account that is now confirmed and signed in.
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
      // Same reasoning as Path 1: fall through to the session check.
    }
  }

  // ── Path 3: Session already established ──────────────────────────────
  // Two ways to arrive here, and the second one is a bug fix.
  //
  // (a) Implicit/redirect. Supabase /auth/v1/verify already set the session
  //     via cookies and we just redirect into the app. Default Supabase email
  //     templates use ConfirmationURL and route through this path
  //     (post-launch bug #4 root cause).
  //
  // (b) A SPENT TOKEN ON AN ACCOUNT THAT IS ALREADY CONFIRMED. Paths 1 and 2
  //     used to redirect straight to /login?error=link_invalid_or_expired the
  //     moment an exchange failed, without ever asking whether the user was
  //     signed in. They now fall through to here.
  //
  //     Confirmation links are single use, and the human is often not the
  //     first to open one: corporate mail scanners pre-fetch links before
  //     delivery. The scanner's request spends the token AND confirms the
  //     account; the customer then clicks their own link and is told it is no
  //     longer valid. Their account exists, works, and is confirmed -- and the
  //     screen says signup failed. Most people do not then go and try the
  //     login form; they leave. That is a drop at the top of a funnel we pay
  //     for.
  //
  //     Checking the session grants nothing: this user is already
  //     authenticated, and this is the same check path (a) has always made.
  //     An expired token with no session still falls to Path 4 and still
  //     errors.
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
 *   2. Fire signup_complete — ONCE PER ACCOUNT, claimed through a flag on
 *      app_metadata rather than a window on created_at. Shared chokepoint the
 *      client-side trackSignupComplete cannot cover for email-confirm / OAuth
 *      / magic-link. See claimSignupComplete for why the window had to go.
 *
 * Pass `userOverride` to avoid a second getUser() round-trip when the caller
 * already has the user object.
 */
/**
 * Claim the one signup_complete this account is entitled to.
 *
 * Returns true exactly once per account -- the first time any callback sees
 * it -- and false forever after.
 *
 * WHY THIS REPLACED A TIME WINDOW. signup_complete used to fire only while
 * `created_at` was under 60 seconds old. That holds right up until something
 * other than the customer opens the confirmation link first: corporate mail
 * scanners pre-fetch links, the account is confirmed within seconds, and the
 * person opens their own link a minute or two later. By then the window has
 * shut and the signup is never recorded as completed, even though they go on
 * to use the product. Two of the first night's email signups were exactly
 * this; one that confirmed inside a minute fired normally, and Google signups
 * were unaffected because they never wait on an email.
 *
 * A flag on the account is idempotent in a way a clock cannot be: it does not
 * care how long the person took.
 *
 * NOT ATOMIC, and that is a considered trade. Two callbacks for the same user
 * in the same instant could both read an unset flag and both fire. The gap
 * between a scanner's fetch and a human's click is minutes, so this is close
 * to unreachable in the case it was written for; a doubled signup event is
 * also a far smaller measurement error than the missing ones it fixes. Making
 * it atomic would mean a table with a unique key on user_id -- worth doing if
 * duplicates ever actually show up.
 */
async function claimSignupComplete(user: {
  id: string;
  created_at: string;
}): Promise<boolean> {
  const admin = createServiceRoleClient();
  // The demo client proxies unknown auth members to a bare function, so these
  // are undefined under DEMO_MODE — guard rather than throw.
  if (typeof admin.auth?.admin?.getUserById !== "function") return false;
  if (typeof admin.auth?.admin?.updateUserById !== "function") return false;

  const { data } = await admin.auth.admin.getUserById(user.id);
  const appMeta = (data?.user?.app_metadata ?? {}) as Record<string, unknown>;

  // Already announced. Nothing to do, on any later visit, forever.
  if (appMeta[SIGNUP_COMPLETE_KEY]) return false;

  // Spread the existing metadata back rather than sending the new key alone.
  // Supabase merges app_metadata on update, but provider and providers live in
  // this same bag — if that ever changed to a replace, sending only the flag
  // would erase them.
  await admin.auth.admin.updateUserById(user.id, {
    app_metadata: {
      ...appMeta,
      [SIGNUP_COMPLETE_KEY]: new Date().toISOString(),
    },
  });

  // Predates the flag: mark it so this runs once, but say nothing. See
  // SIGNUP_FLAG_EPOCH_MS — announcing here would report every existing
  // customer as a fresh signup.
  if (new Date(user.created_at).getTime() < SIGNUP_FLAG_EPOCH_MS) return false;

  return true;
}

async function onAuthenticated(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  userOverride?: { id: string; created_at: string; app_metadata?: { provider?: string } } | null,
  attribution: Attribution = {},
) {
  try {
    const user = userOverride ?? (await supabase.auth.getUser()).data.user;
    if (!user) return;

    await persistAttribution(user.id, attribution);

    // Once per account, however long the customer took to open their link.
    if (!(await claimSignupComplete(user))) return;
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
