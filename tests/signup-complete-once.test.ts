// signup_complete, once per account.
//
// WHY IT CHANGED. The event used to fire only while the account's created_at
// was under 60 seconds old. That holds until something other than the customer
// opens the confirmation link first -- corporate mail scanners pre-fetch links,
// so the account is confirmed within seconds and the person opens their own
// link a minute or two later. By then the window has shut and the signup is
// never recorded as completed, even though they go on to use the product.
//
// Two of the first night's email signups were exactly this. One that confirmed
// inside a minute fired normally, and Google signups were unaffected -- they
// never wait on an email.
//
// A flag on the account is idempotent in a way a clock cannot be: it does not
// care how long the person took.
//
// vitest runs environment "node" with no Supabase, so these pin the contract in
// the convention of subscription-livemode.test.ts.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const CALLBACK = readFileSync(
  path.join(repoRoot, "src", "app", "auth", "callback", "route.ts"),
  "utf8",
);

/** Source with comment lines removed, so prose describing a rule is never
 *  mistaken for the rule itself. */
const codeOnly = (src: string): string =>
  src
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const code = codeOnly(CALLBACK);

describe("the 60-second window is gone", () => {
  // THE BUG. Any surviving recency comparison means a slow confirmation is
  // still silently dropped.
  it("no longer gates the event on how old the account is", () => {
    expect(code).not.toContain("SIGNUP_RECENCY_MS");
  });

  it("claims the event through a flag instead", () => {
    expect(code).toContain("claimSignupComplete");
    expect(code).toContain("SIGNUP_COMPLETE_KEY");
  });

  // The claim must gate the event. If trackServerEvent could still be reached
  // without it, the flag would be decoration.
  it("fires only when the claim succeeds", () => {
    const start = code.indexOf("async function onAuthenticated");
    const body = code.slice(start, code.indexOf("trackServerEvent", start));
    expect(body).toMatch(/if\s*\(!\(await claimSignupComplete\(user\)\)\)\s*return;/);
  });
});

describe("the flag is kept where a user cannot reach it", () => {
  // user_metadata is writable by the user's own session, so a flag there could
  // be cleared from the browser and the event re-fired. app_metadata is
  // service-role only.
  it("writes to app_metadata, not user_metadata", () => {
    const start = code.indexOf("async function claimSignupComplete");
    const body = code.slice(start, code.indexOf("async function onAuthenticated", start));
    expect(body).toContain("app_metadata");
    expect(body).not.toContain("user_metadata");
  });

  // provider and providers live in the same bag. Sending the flag alone would
  // erase them if Supabase ever replaced rather than merged.
  it("preserves the metadata already on the account", () => {
    const start = code.indexOf("async function claimSignupComplete");
    const body = code.slice(start, code.indexOf("async function onAuthenticated", start));
    expect(body).toContain("...appMeta");
  });

  // DEMO_MODE proxies unknown auth members to a bare function, so calling
  // through without a guard throws.
  it("guards the admin calls for the demo client", () => {
    const start = code.indexOf("async function claimSignupComplete");
    const body = code.slice(start, code.indexOf("async function onAuthenticated", start));
    expect(body).toContain('typeof admin.auth?.admin?.getUserById !== "function"');
    expect(body).toContain('typeof admin.auth?.admin?.updateUserById !== "function"');
  });
});

describe("existing accounts are not announced as new signups", () => {
  // THE REGRESSION THIS AVOIDS. Every account that predates the flag has no
  // flag, so first sight looks exactly like a new signup. Without a boundary,
  // deploying this would report the entire userbase as signing up again.
  it("grandfathers accounts created before the flag existed", () => {
    expect(code).toContain("SIGNUP_FLAG_EPOCH_MS");
    const start = code.indexOf("async function claimSignupComplete");
    const body = code.slice(start, code.indexOf("async function onAuthenticated", start));
    expect(body).toContain("SIGNUP_FLAG_EPOCH_MS");
    expect(body).toContain("return false");
  });

  // Flag first, decide second. A grandfathered account must still be marked,
  // or it is re-examined on every single sign-in forever.
  it("marks a grandfathered account before deciding not to announce it", () => {
    const start = code.indexOf("async function claimSignupComplete");
    const body = code.slice(start, code.indexOf("async function onAuthenticated", start));
    const update = body.indexOf("updateUserById");
    const epoch = body.indexOf("SIGNUP_FLAG_EPOCH_MS");
    expect(update).toBeGreaterThan(-1);
    expect(epoch).toBeGreaterThan(update);
  });
});

describe("what must not have changed", () => {
  // Attribution is written for every authenticated visit, not just fresh
  // signups — the fix for the Phase-2 measurement gap. The claim must not have
  // been placed in front of it.
  it("still persists attribution on every authenticated visit", () => {
    const start = code.indexOf("async function onAuthenticated");
    const body = code.slice(start);
    const attribution = body.indexOf("persistAttribution");
    const claim = body.indexOf("claimSignupComplete(user)");
    expect(attribution).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(attribution);
  });
});
