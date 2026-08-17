// Proves gclid + utm_campaign survive the Google OAuth round-trip.
//
// The round-trip has four hops, and the test walks all of them rather than
// asserting on any single function:
//
//   1. Ad click lands on /v/<variant>?gclid=...&utm_campaign=... — layout.tsx
//      writes the values into sessionStorage.
//   2. User navigates to /signup (client-side nav — the query string is GONE).
//   3. "Continue with Google" builds the `redirectTo` handed to Supabase.
//      This URL is the only thing that survives the trip to accounts.google.com.
//   4. Google returns to /auth/callback; the route reads the params back off it.
//
// If any hop drops the values, Phase 2 ad attribution reports nothing, so the
// assertion at the end compares against the ORIGINAL ad-click values.

import { describe, it, expect } from "vitest";
import {
  ATTRIBUTION_COOKIE_MAX_AGE,
  GCLID_STORAGE_KEY,
  UTM_CAMPAIGN_STORAGE_KEY,
  appendAttributionToPath,
  buildOAuthRedirectTo,
  decodeAttributionCookie,
  encodeAttributionCookie,
  readAttribution,
  resolveRelayedAttribution,
  resolvePayIntentAttribution,
  sanitizeGclid,
  sanitizeGclidRelaxed,
  sanitizeUtmCampaign,
  writeAttributionCookie,
  ACQUISITION_GCLID_KEY,
  ACQUISITION_UTM_CAMPAIGN_KEY,
  LAST_TOUCH_GCLID_KEY,
  LAST_TOUCH_UTM_CAMPAIGN_KEY,
} from "./attribution";

// A realistic Google click id: 40+ chars with a real prefix. Using something
// like "test123" here would make every test below pass against a relay that is
// broken in production, because layout.tsx would reject it on the way in.
const REAL_GCLID = "CjwKCAjw5remBhBiEiwAxL4L9mQ2Kk8ZzR7vN3pYwT6bXhFgD1sJ0aQeR4uV8cWnMxYzAbCdEfGh";
const REAL_CAMPAIGN = "fraudshield-search-v1";

/** Minimal sessionStorage stand-in — the helper only needs getItem. */
function fakeStorage(entries: Record<string, string>) {
  return { getItem: (key: string) => entries[key] ?? null };
}

describe("gclid + utm_campaign survive the OAuth round-trip", () => {
  it("relays both values from the ad click through to /auth/callback", () => {
    // Hop 1 — ad click captured into sessionStorage by layout.tsx.
    const storage = fakeStorage({
      [GCLID_STORAGE_KEY]: REAL_GCLID,
      [UTM_CAMPAIGN_STORAGE_KEY]: REAL_CAMPAIGN,
    });

    // Hop 2 — user is now on /signup with a BARE url (client-side nav dropped
    // the query string). This is the case a URL-only relay would silently miss.
    const onSignup = readAttribution("", storage);
    expect(onSignup).toEqual({ gclid: REAL_GCLID, utm_campaign: REAL_CAMPAIGN });

    // Hop 3 — the redirectTo handed to supabase.auth.signInWithOAuth.
    const redirectTo = buildOAuthRedirectTo(
      "https://fraudshield.draftlabs.org",
      "/dashboard",
      onSignup,
    );

    // Hop 4 — Google sends the browser back; the callback re-parses the URL.
    const backFromGoogle = new URL(redirectTo);
    const received = resolveRelayedAttribution(
      {
        gclid: backFromGoogle.searchParams.get("gclid"),
        utm_campaign: backFromGoogle.searchParams.get("utm_campaign"),
      },
      null, // no cookie — params alone must carry it
    );

    expect(received.gclid).toBe(REAL_GCLID);
    expect(received.utm_campaign).toBe(REAL_CAMPAIGN);
    expect(backFromGoogle.searchParams.get("next")).toBe("/dashboard");
  });

  it("still relays both values when the redirect allow-list strips query params", () => {
    const attribution = { gclid: REAL_GCLID, utm_campaign: REAL_CAMPAIGN };

    // The browser sets the fallback cookie before leaving for Google.
    const documentRef = { cookie: "" };
    writeAttributionCookie(attribution, documentRef);
    expect(documentRef.cookie).toContain(`Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE}`);
    expect(documentRef.cookie).toContain("SameSite=Lax");

    // Supabase returned to a bare /auth/callback — every relayed param gone.
    const cookieValue = documentRef.cookie.split(";")[0].split("=").slice(1).join("=");
    const received = resolveRelayedAttribution(
      { gclid: null, utm_campaign: null },
      cookieValue,
    );

    expect(received.gclid).toBe(REAL_GCLID);
    expect(received.utm_campaign).toBe(REAL_CAMPAIGN);
  });

  it("prefers explicit params over a stale cookie", () => {
    const staleCookie = encodeAttributionCookie({
      gclid: "CjwKCAjwOLDcampaignOLDcampaignOLDcampaignOLD123",
      utm_campaign: "old-campaign",
    });
    const received = resolveRelayedAttribution(
      { gclid: REAL_GCLID, utm_campaign: REAL_CAMPAIGN },
      staleCookie,
    );
    expect(received.gclid).toBe(REAL_GCLID);
    expect(received.utm_campaign).toBe(REAL_CAMPAIGN);
  });

  it("lets a direct sitelink landing override sessionStorage", () => {
    // ads.yaml points a sitelink straight at /signup with utm params on the URL.
    const storage = fakeStorage({ [UTM_CAMPAIGN_STORAGE_KEY]: "older-campaign" });
    const attribution = readAttribution(`?utm_campaign=${REAL_CAMPAIGN}`, storage);
    expect(attribution.utm_campaign).toBe(REAL_CAMPAIGN);
  });

  it("preserves an existing query string on the post-login destination", () => {
    // safeNext permits any same-origin path, including one that already has a
    // query string — naive concatenation would emit a second "?" and corrupt it.
    const path = appendAttributionToPath("/dashboard?tab=history", {
      gclid: REAL_GCLID,
      utm_campaign: REAL_CAMPAIGN,
    });
    const parsed = new URL(path, "http://placeholder.invalid");
    expect(parsed.pathname).toBe("/dashboard");
    expect(parsed.searchParams.get("tab")).toBe("history");
    expect(parsed.searchParams.get("gclid")).toBe(REAL_GCLID);
    expect(parsed.searchParams.get("utm_campaign")).toBe(REAL_CAMPAIGN);
  });
});

describe("attribution validation", () => {
  it("rejects click ids that layout.tsx would refuse", () => {
    // These are the values that make a relay look healthy while attribution is
    // actually dead: too short, wrong prefix, or not a click id at all.
    expect(sanitizeGclid("test123")).toBeUndefined();
    expect(sanitizeGclid("Cj")).toBeUndefined();
    expect(sanitizeGclid("Zz" + "a".repeat(60))).toBeUndefined();
    expect(sanitizeGclid("Cj" + "a".repeat(20))).toBeUndefined();
    expect(sanitizeGclid("")).toBeUndefined();
    expect(sanitizeGclid(null)).toBeUndefined();
  });

  it("accepts a real click id", () => {
    expect(sanitizeGclid(REAL_GCLID)).toBe(REAL_GCLID);
    expect(sanitizeGclid(`  ${REAL_GCLID}  `)).toBe(REAL_GCLID);
  });

  it("rejects malformed utm_campaign values", () => {
    expect(sanitizeUtmCampaign("has spaces")).toBeUndefined();
    expect(sanitizeUtmCampaign("<script>")).toBeUndefined();
    expect(sanitizeUtmCampaign("a".repeat(129))).toBeUndefined();
    expect(sanitizeUtmCampaign("")).toBeUndefined();
    expect(sanitizeUtmCampaign(null)).toBeUndefined();
  });

  it("never throws on a malformed cookie", () => {
    expect(decodeAttributionCookie("not-json")).toEqual({});
    expect(decodeAttributionCookie("%7Bbroken")).toEqual({});
    expect(decodeAttributionCookie(null)).toEqual({});
    expect(decodeAttributionCookie(encodeURIComponent('"a string"'))).toEqual({});
  });

  it("omits absent values instead of relaying empty strings", () => {
    const redirectTo = buildOAuthRedirectTo("https://example.com", "/dashboard", {});
    const url = new URL(redirectTo);
    expect(url.searchParams.has("gclid")).toBe(false);
    expect(url.searchParams.has("utm_campaign")).toBe(false);
    expect(url.searchParams.get("next")).toBe("/dashboard");
  });

  it("does not write a cookie when there is nothing to relay", () => {
    const documentRef = { cookie: "" };
    writeAttributionCookie({}, documentRef);
    expect(documentRef.cookie).toBe("");
  });
});

// --- Phase 2 fake-door attribution -----------------------------------------
//
// The day-0 relay probe is mandatory before a Phase 2 campaign may launch, and
// it deliberately uses a gclid that is NOT a real Google click id. These tests
// pin the two properties that make the probe possible without weakening the
// analytics capture path.

const PROBE_GCLID = "probe-20260811";
const PROBE_CAMPAIGN = "dayzero-probe";
const PHASE2_CAMPAIGN = "fraudshield-search-phase2-v1";

describe("sanitizeGclidRelaxed", () => {
  it("accepts the day-0 probe gclid that the strict gate rejects", () => {
    // This asymmetry IS the feature: without it the probe can never pass, and
    // make distribute refuses a phase-2 config with no recorded probe date.
    expect(sanitizeGclid(PROBE_GCLID)).toBeUndefined();
    expect(sanitizeGclidRelaxed(PROBE_GCLID)).toBe(PROBE_GCLID);
  });

  it("still accepts a real Google click id unchanged", () => {
    expect(sanitizeGclidRelaxed(REAL_GCLID)).toBe(REAL_GCLID);
  });

  it("still rejects invalid charset and over-length input", () => {
    expect(sanitizeGclidRelaxed("has spaces")).toBeUndefined();
    expect(sanitizeGclidRelaxed("semi;colon")).toBeUndefined();
    expect(sanitizeGclidRelaxed("a".repeat(513))).toBeUndefined();
    expect(sanitizeGclidRelaxed("")).toBeUndefined();
    expect(sanitizeGclidRelaxed(null)).toBeUndefined();
  });

  it("leaves the strict gate untouched for the analytics capture path", () => {
    expect(sanitizeGclid(REAL_GCLID)).toBe(REAL_GCLID);
    expect(sanitizeGclid("short")).toBeUndefined();
    expect(sanitizeGclid("X".repeat(64))).toBeUndefined(); // right length, wrong prefix
  });
});

describe("resolvePayIntentAttribution", () => {
  it("prefers the server-persisted user record over the client value", () => {
    const result = resolvePayIntentAttribution(
      {
        [ACQUISITION_GCLID_KEY]: REAL_GCLID,
        [ACQUISITION_UTM_CAMPAIGN_KEY]: PHASE2_CAMPAIGN,
      },
      { gclid: "CjwKspoofedspoofedspoofedspoofedspoofedspoofed", utm_campaign: "attacker-campaign" },
    );
    expect(result.gclid).toBe(REAL_GCLID);
    expect(result.utm_campaign).toBe(PHASE2_CAMPAIGN);
    expect(result.source).toBe("user_record");
  });

  it("falls back to the client value when the user record is empty", () => {
    // The day-0 probe lands here: the strict sanitizer stopped its gclid from
    // ever reaching user_metadata, so the client read is the only source.
    const result = resolvePayIntentAttribution(
      {},
      { gclid: PROBE_GCLID, utm_campaign: PROBE_CAMPAIGN },
    );
    expect(result.gclid).toBe(PROBE_GCLID);
    expect(result.utm_campaign).toBe(PROBE_CAMPAIGN);
    expect(result.source).toBe("client");
  });

  it("reports source 'none' when neither source has anything", () => {
    const result = resolvePayIntentAttribution({}, {});
    expect(result.gclid).toBeUndefined();
    expect(result.utm_campaign).toBeUndefined();
    expect(result.source).toBe("none");
  });

  it("treats a user record holding only a campaign as authoritative", () => {
    // A probe user DOES get acquisition_utm_campaign persisted (it passes the
    // campaign sanitizer) while its gclid does not — so the record wins and the
    // gclid is simply absent rather than silently taken from the client.
    const result = resolvePayIntentAttribution(
      { [ACQUISITION_UTM_CAMPAIGN_KEY]: PROBE_CAMPAIGN },
      { gclid: PROBE_GCLID, utm_campaign: PROBE_CAMPAIGN },
    );
    expect(result.utm_campaign).toBe(PROBE_CAMPAIGN);
    expect(result.gclid).toBeUndefined();
    expect(result.source).toBe("user_record");
  });

  it("ignores non-string and malformed metadata without throwing", () => {
    const result = resolvePayIntentAttribution(
      { [ACQUISITION_GCLID_KEY]: 42, [ACQUISITION_UTM_CAMPAIGN_KEY]: { nested: true } },
      { gclid: REAL_GCLID, utm_campaign: PHASE2_CAMPAIGN },
    );
    expect(result.source).toBe("client");
    expect(result.gclid).toBe(REAL_GCLID);
  });

  it("handles null metadata and null client attribution", () => {
    expect(resolvePayIntentAttribution(null, null).source).toBe("none");
    expect(resolvePayIntentAttribution(undefined, undefined).source).toBe("none");
  });
});

describe("resolvePayIntentAttribution — last-touch precedence", () => {
  // A Phase-1 click id, distinct from REAL_GCLID so the assertions can tell
  // which of the two pairs actually won.
  const PHASE1_GCLID =
    "CjwKCAjwPHASE1oldertouchZzR7vN3pYwT6bXhFgD1sJ0aQeR4uV8cWnMxYzAbCdEfGh";

  it("prefers last touch over the frozen first-touch record", () => {
    // The exact bug this fixes: a Phase-1 user clicks a Phase-2 ad and LOGS IN
    // rather than signing up. acquisition_* is first-touch-wins so it still
    // holds Phase 1 forever. Without last-touch the pay_intent row carries a
    // Phase-1 gclid, the verdict's paid-gclid filter drops it as unattributed,
    // and the click still counts in the denominator — biasing the rate down.
    const result = resolvePayIntentAttribution(
      {
        [ACQUISITION_GCLID_KEY]: PHASE1_GCLID,
        [ACQUISITION_UTM_CAMPAIGN_KEY]: REAL_CAMPAIGN,
        [LAST_TOUCH_GCLID_KEY]: REAL_GCLID,
        [LAST_TOUCH_UTM_CAMPAIGN_KEY]: PHASE2_CAMPAIGN,
      },
      {},
    );
    expect(result.gclid).toBe(REAL_GCLID);
    expect(result.utm_campaign).toBe(PHASE2_CAMPAIGN);
    expect(result.source).toBe("last_touch");
  });

  it("falls back to first touch for users predating last-touch", () => {
    // Accounts created before this change have acquisition_* and nothing else;
    // they must keep resolving exactly as they did before.
    const result = resolvePayIntentAttribution(
      {
        [ACQUISITION_GCLID_KEY]: REAL_GCLID,
        [ACQUISITION_UTM_CAMPAIGN_KEY]: PHASE2_CAMPAIGN,
      },
      {},
    );
    expect(result.gclid).toBe(REAL_GCLID);
    expect(result.utm_campaign).toBe(PHASE2_CAMPAIGN);
    expect(result.source).toBe("user_record");
  });

  it("prefers a server-written last touch over an attacker-supplied client value", () => {
    const result = resolvePayIntentAttribution(
      {
        [LAST_TOUCH_GCLID_KEY]: REAL_GCLID,
        [LAST_TOUCH_UTM_CAMPAIGN_KEY]: PHASE2_CAMPAIGN,
      },
      {
        gclid: "CjwKspoofedspoofedspoofedspoofedspoofedspoofed",
        utm_campaign: "attacker-campaign",
      },
    );
    expect(result.gclid).toBe(REAL_GCLID);
    expect(result.utm_campaign).toBe(PHASE2_CAMPAIGN);
    expect(result.source).toBe("last_touch");
  });

  it("ignores malformed last-touch values and falls through to first touch", () => {
    const result = resolvePayIntentAttribution(
      {
        [LAST_TOUCH_GCLID_KEY]: { nested: true },
        [LAST_TOUCH_UTM_CAMPAIGN_KEY]: "has spaces and !!",
        [ACQUISITION_GCLID_KEY]: REAL_GCLID,
      },
      {},
    );
    expect(result.gclid).toBe(REAL_GCLID);
    expect(result.source).toBe("user_record");
  });

  it("uses a campaign-only last touch without borrowing the first-touch gclid", () => {
    // A visit that carried only utm_campaign must not silently pair that
    // campaign with an older click id — that would fabricate an attribution
    // pair no single visit ever produced.
    const result = resolvePayIntentAttribution(
      {
        [ACQUISITION_GCLID_KEY]: PHASE1_GCLID,
        [LAST_TOUCH_UTM_CAMPAIGN_KEY]: PHASE2_CAMPAIGN,
      },
      {},
    );
    expect(result.utm_campaign).toBe(PHASE2_CAMPAIGN);
    expect(result.gclid).toBeUndefined();
    expect(result.source).toBe("last_touch");
  });
});
