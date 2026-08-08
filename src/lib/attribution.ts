// Paid-attribution relay across the OAuth round-trip.
//
// Why this exists: `src/app/layout.tsx` captures `?gclid=` and `?utm_*` into
// sessionStorage BEFORE hydration, and `src/lib/analytics.ts` registers them as
// PostHog super-properties. That covers every CLIENT-side event. It does not
// cover the OAuth signup, because:
//
//   1. `/auth/callback` fires `signup_complete` SERVER-side (it is the only
//      chokepoint that sees OAuth / email-confirm / magic-link signups), and the
//      server cannot read sessionStorage.
//   2. Ads land on `/v/<variant>` and the CTA is a client-side nav that drops the
//      query string, so by the time the user reaches /login or /signup the URL is
//      usually bare — the values only exist in sessionStorage.
//
// So the click ids are relayed explicitly: read them on the client, put them on
// the `redirectTo` URL handed to Supabase, and also drop them in a short-lived
// first-party cookie as a fallback for the case where the Supabase redirect
// allow-list strips unknown query params. `/auth/callback` then reads whichever
// survived, attaches them to the server-side event, persists them onto the user
// record, and re-appends them to the final redirect so the layout.tsx capture
// script can re-arm sessionStorage.
//
// Everything here is pure and dependency-free so it is unit-testable without a
// browser, a Supabase project, or a running Next.js server.

/** Keys written by the pre-hydration capture script in `src/app/layout.tsx`. */
export const GCLID_STORAGE_KEY = "__ph_gclid";
export const UTM_CAMPAIGN_STORAGE_KEY = "__ph_utm_campaign";

/** Short-lived first-party cookie carrying attribution across the OAuth hop. */
export const ATTRIBUTION_COOKIE = "__fs_attr";

/** 10 minutes — long enough for a Google consent screen, short enough to be stale-proof. */
export const ATTRIBUTION_COOKIE_MAX_AGE = 600;

// Google click ids are long and start with a small set of prefixes. This MUST
// stay identical to the gate in src/app/layout.tsx — if the two disagree, a
// value accepted here would be silently dropped there (or vice versa) and the
// two capture paths would report different attribution for the same user.
const GCLID_MIN_LENGTH = 40;
const GCLID_PREFIX = /^(Cj|EAI|CIa)/;
const GCLID_CHARSET = /^[A-Za-z0-9_-]+$/;
const GCLID_MAX_LENGTH = 512;

// utm_campaign is operator-authored (see experiment/ads.yaml), not user input,
// but it arrives over the wire so it is treated as untrusted: strict charset,
// hard length cap, no whitespace or control characters.
const UTM_CAMPAIGN_PATTERN = /^[A-Za-z0-9._-]+$/;
const UTM_CAMPAIGN_MAX_LENGTH = 128;

export type Attribution = {
  gclid?: string;
  utm_campaign?: string;
};

/**
 * Returns the gclid unchanged when it looks like a real Google click id,
 * otherwise undefined. Rejecting junk here is the point: a test value like
 * "test123" is NOT a gclid, and letting it through would make the relay look
 * healthy while production attribution silently broke.
 */
export function sanitizeGclid(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.length < GCLID_MIN_LENGTH) return undefined;
  if (value.length > GCLID_MAX_LENGTH) return undefined;
  if (!GCLID_PREFIX.test(value)) return undefined;
  if (!GCLID_CHARSET.test(value)) return undefined;
  return value;
}

/** Returns a safe utm_campaign, or undefined when it is missing or malformed. */
export function sanitizeUtmCampaign(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > UTM_CAMPAIGN_MAX_LENGTH) return undefined;
  if (!UTM_CAMPAIGN_PATTERN.test(value)) return undefined;
  return value;
}

/** Drops unset/invalid members so callers never spread `undefined` into events. */
export function sanitizeAttribution(raw: {
  gclid?: string | null;
  utm_campaign?: string | null;
}): Attribution {
  const attribution: Attribution = {};
  const gclid = sanitizeGclid(raw.gclid);
  if (gclid) attribution.gclid = gclid;
  const utmCampaign = sanitizeUtmCampaign(raw.utm_campaign);
  if (utmCampaign) attribution.utm_campaign = utmCampaign;
  return attribution;
}

export function hasAttribution(attribution: Attribution): boolean {
  return Boolean(attribution.gclid || attribution.utm_campaign);
}

/**
 * Reads attribution on the client. URL params win when present (a Google
 * sitelink can point straight at /signup?gclid=...), otherwise falls back to the
 * sessionStorage values captured at the landing page.
 *
 * `search` and `storage` are injected so this stays pure and testable.
 */
export function readAttribution(
  search: string,
  storage: Pick<Storage, "getItem"> | null,
): Attribution {
  const params = new URLSearchParams(search);
  const read = (key: string) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      // sessionStorage throws in private mode / sandboxed iframes.
      return null;
    }
  };
  return sanitizeAttribution({
    gclid: params.get("gclid") ?? read(GCLID_STORAGE_KEY),
    utm_campaign: params.get("utm_campaign") ?? read(UTM_CAMPAIGN_STORAGE_KEY),
  });
}

/**
 * Appends attribution to a same-origin path, preserving any query string the
 * path already has. Uses the URL API rather than string concatenation so a
 * `next` of "/dashboard?tab=history" does not end up with a second "?".
 */
export function appendAttributionToPath(path: string, attribution: Attribution): string {
  const url = new URL(path, "http://placeholder.invalid");
  if (attribution.gclid) url.searchParams.set("gclid", attribution.gclid);
  if (attribution.utm_campaign) url.searchParams.set("utm_campaign", attribution.utm_campaign);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Builds the `redirectTo` handed to `supabase.auth.signInWithOAuth`. Supabase
 * sends the browser to Google and Google sends it back here, so this URL is the
 * only thing under our control that makes the round-trip.
 */
export function buildOAuthRedirectTo(
  origin: string,
  next: string,
  attribution: Attribution,
): string {
  const url = new URL("/auth/callback", origin);
  url.searchParams.set("next", next);
  if (attribution.gclid) url.searchParams.set("gclid", attribution.gclid);
  if (attribution.utm_campaign) url.searchParams.set("utm_campaign", attribution.utm_campaign);
  return url.toString();
}

/** Serializes attribution for the fallback cookie. */
export function encodeAttributionCookie(attribution: Attribution): string {
  return encodeURIComponent(JSON.stringify(attribution));
}

/** Parses the fallback cookie. Never throws — malformed input yields {}. */
export function decodeAttributionCookie(raw: string | null | undefined): Attribution {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(decodeURIComponent(raw));
    if (!parsed || typeof parsed !== "object") return {};
    return sanitizeAttribution(parsed as { gclid?: string; utm_campaign?: string });
  } catch {
    return {};
  }
}

/**
 * Writes the fallback cookie from the browser. Cannot be httpOnly — the client
 * is what has the sessionStorage values — which is acceptable because the
 * payload is non-secret marketing identifiers, never credentials. `/auth/callback`
 * clears it as soon as it has been read.
 */
export function writeAttributionCookie(
  attribution: Attribution,
  documentRef: { cookie: string } | undefined = typeof document === "undefined"
    ? undefined
    : document,
): void {
  if (!documentRef || !hasAttribution(attribution)) return;
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  documentRef.cookie =
    `${ATTRIBUTION_COOKIE}=${encodeAttributionCookie(attribution)}` +
    `; Path=/; Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/**
 * Server-side resolution: explicit query params win, cookie is the fallback for
 * when the Supabase redirect allow-list strips unknown params.
 */
export function resolveRelayedAttribution(
  params: { gclid?: string | null; utm_campaign?: string | null },
  cookieValue: string | null | undefined,
): Attribution {
  const fromParams = sanitizeAttribution(params);
  if (hasAttribution(fromParams)) return fromParams;
  return decodeAttributionCookie(cookieValue);
}
