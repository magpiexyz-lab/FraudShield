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

/**
 * Relaxed gclid validation, used ONLY by the Phase 2 `pay_intent` fake door.
 *
 * `sanitizeGclid` above enforces the real-Google-click-id shape (>=40 chars,
 * Cj/EAI/CIa prefix). That is correct for analytics capture, but it makes the
 * MANDATORY day-0 relay probe impossible: the probe walks the funnel with
 * `?gclid=probe-<YYYYMMDD>` and its verification requires that exact value to
 * appear on the pay_intent row. Routed through the strict gate the value is
 * dropped, the probe fails, `dayzero_probe_passed_at` never gets recorded, and
 * `make distribute` refuses the phase-2 config — the campaign cannot launch.
 *
 * Relaxing here is safe because strictness at this layer is redundant: the
 * verdict pipeline applies its own paid-gclid filter (length > 40 plus the same
 * prefix set) when computing the numerator, so a probe- or test-shaped value can
 * never be counted as paid traffic no matter what we store. Charset and length
 * caps are still enforced — this is untrusted input off the wire.
 */
export function sanitizeGclidRelaxed(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const value = raw.trim();
  if (value.length === 0 || value.length > GCLID_MAX_LENGTH) return undefined;
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

/** First-touch keys `persistAttribution` writes onto `auth.users.user_metadata`. */
export const ACQUISITION_GCLID_KEY = "acquisition_gclid";
export const ACQUISITION_UTM_CAMPAIGN_KEY = "acquisition_utm_campaign";

/**
 * Last-touch keys, rewritten on EVERY authenticated callback rather than once.
 *
 * The acquisition_* pair is deliberately first-touch-wins: it answers "which
 * campaign acquired this customer?" months later, and a later organic login
 * must not overwrite the paid click that actually won them. That is the right
 * rule for lifetime attribution and the wrong one for a phase-scoped ad test.
 *
 * A Phase-1 user who clicks a Phase-2 ad and LOGS IN rather than signing up
 * keeps their Phase-1 acquisition values forever, so their pay_intent row
 * carries a Phase-1 gclid. The cross-MVP verdict filters the numerator to the
 * paid-gclid subset for the campaign under test, drops that row as
 * unattributed, and the click still counts in the denominator — biasing the
 * measured rate DOWN. A marginal NO_GO can be an artefact of this alone.
 *
 * Recording last-touch alongside first-touch answers both questions without
 * either overwriting the other.
 */
export const LAST_TOUCH_GCLID_KEY = "last_touch_gclid";
export const LAST_TOUCH_UTM_CAMPAIGN_KEY = "last_touch_utm_campaign";

/** Which source supplied the attribution stored on a pay_intent row. */
export type AttributionSource = "last_touch" | "user_record" | "client" | "none";

export type PayIntentAttribution = Attribution & { source: AttributionSource };

/**
 * Resolves the attribution to stamp on a `pay_intent` event and row.
 *
 * Three sources, none complete on its own, in precedence order:
 *
 *   - Last touch (`last_touch_*`) is the campaign that produced THIS visit,
 *     which is exactly what a phase-scoped ad test measures. Server-written on
 *     every authenticated callback, so it is no less trustworthy than the
 *     acquisition pair it now precedes.
 *   - The user record (`acquisition_*` in user_metadata) is first-touch and
 *     also server-written, but it is frozen at signup: a returning user's
 *     Phase-2 click can never appear there. It remains the fallback for users
 *     who signed up before last-touch existed. `persistAttribution` only runs
 *     when attribution was present, so organic users — and the day-0 probe,
 *     whose gclid the strict sanitizer rejects — have nothing in either.
 *   - The client value, read at click time from the URL or sessionStorage, fills
 *     those gaps but is attacker-controllable.
 *
 * The user record therefore wins whenever it has anything, and the client value
 * is a fallback rather than an override. An earlier revision REJECTED client
 * values matching the phase2 campaign pattern to close the forgery vector, but
 * that silently discarded genuine pay-intents: `persistAttribution` is wrapped
 * in a bare catch, so its failure is invisible, and the resulting data loss
 * lands precisely on the measurement this exists to produce. Accepting the
 * fallback and recording `source` keeps the data and leaves any pollution
 * detectable after the fact.
 *
 * Pure and dependency-free so it is unit-testable — the demo Supabase client
 * hardcodes `user_metadata` to `{}`, so this logic is unreachable from a
 * route-level test.
 */
export function resolvePayIntentAttribution(
  userMetadata: Record<string, unknown> | null | undefined,
  clientAttribution: { gclid?: string | null; utm_campaign?: string | null } | null | undefined,
): PayIntentAttribution {
  const meta = userMetadata ?? {};
  const readMeta = (key: string) => {
    const value = meta[key];
    return typeof value === "string" ? value : null;
  };

  const readPair = (gclidKey: string, campaignKey: string): Attribution => {
    const pair: Attribution = {};
    const gclid = sanitizeGclidRelaxed(readMeta(gclidKey));
    if (gclid) pair.gclid = gclid;
    const campaign = sanitizeUtmCampaign(readMeta(campaignKey));
    if (campaign) pair.utm_campaign = campaign;
    return pair;
  };

  const fromLastTouch = readPair(LAST_TOUCH_GCLID_KEY, LAST_TOUCH_UTM_CAMPAIGN_KEY);
  if (hasAttribution(fromLastTouch)) return { ...fromLastTouch, source: "last_touch" };

  const fromRecord = readPair(ACQUISITION_GCLID_KEY, ACQUISITION_UTM_CAMPAIGN_KEY);
  if (hasAttribution(fromRecord)) return { ...fromRecord, source: "user_record" };

  const fromClient: Attribution = {};
  const clientGclid = sanitizeGclidRelaxed(clientAttribution?.gclid);
  if (clientGclid) fromClient.gclid = clientGclid;
  const clientCampaign = sanitizeUtmCampaign(clientAttribution?.utm_campaign);
  if (clientCampaign) fromClient.utm_campaign = clientCampaign;
  if (hasAttribution(fromClient)) return { ...fromClient, source: "client" };

  return { source: "none" };
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
