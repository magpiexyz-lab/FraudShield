// A confirmation link that someone else opened first.
//
// WHY IT EXISTS. Confirmation links are single use, and the customer is often
// not the first to open one: corporate mail scanners pre-fetch links before
// delivery. The scanner's request spends the token AND confirms the account.
// The customer then clicks their own link and, before this fix, was told:
//
//   "That confirmation link is no longer valid"
//
// Their account existed, was confirmed, and worked -- and the screen said
// signup had failed. Most people do not then go and try the login form on a
// hunch; they leave. That is a drop at the very top of a funnel we pay for.
//
// The cause: Paths 1 and 2 of /auth/callback redirected to the error page the
// moment an exchange failed, without ever asking whether the user was signed
// in. The session check they needed was already in the route, at Path 3, but
// was only reachable when the URL carried no token at all -- and a spent link
// still carries its token.
//
// Reported from a real signup on 16 Oct 2026, the day paid traffic started.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const MOCK_CODE = "abcdef0123456789ABCDEF_-mockcode01";
const MOCK_TOKEN_HASH = "pkce_0123456789abcdef0123456789abcdef0123456789";

/** A spent link: Supabase rejects the token because it has already been used. */
const spent = async () => ({ error: { message: "Token has expired or is invalid" } });

/** Someone who IS signed in -- the scanner's fetch confirmed them. */
const signedInUser = {
  id: "11111111-1111-4111-8111-111111111111",
  // Old enough that signup_complete is not re-fired on this request.
  created_at: new Date(Date.now() - 86_400_000).toISOString(),
  app_metadata: { provider: "email" },
};

function mockSupabase(opts: { user: typeof signedInUser | null; exchangeFails: boolean }) {
  vi.doMock("@/lib/supabase-server", () => ({
    createServerSupabaseClient: async () => ({
      auth: {
        exchangeCodeForSession: opts.exchangeFails
          ? spent
          : async () => ({ error: null }),
        verifyOtp: opts.exchangeFails ? spent : async () => ({ error: null }),
        getUser: async () => ({ data: { user: opts.user } }),
      },
    }),
    createServiceRoleClient: () => ({
      from: () => ({
        update: () => ({ eq: async () => ({ error: null }) }),
        upsert: async () => ({ error: null }),
      }),
    }),
  }));
}

async function callbackGet(url: string) {
  const { GET } = await import("@/app/auth/callback/route");
  return GET(new Request(url));
}

const locationOf = (res: Response) => res.headers.get("location") ?? "";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("@/lib/supabase-server");
  vi.resetModules();
});

describe("a spent link belonging to an account that is now confirmed", () => {
  // THE BUG, as a test. Before the fix this redirected to
  // /login?error=link_invalid_or_expired.
  it("sends a signed-in user into the app after a failed code exchange", async () => {
    mockSupabase({ user: signedInUser, exchangeFails: true });
    const res = await callbackGet(
      `http://localhost/auth/callback?code=${MOCK_CODE}`,
    );
    expect([302, 307]).toContain(res.status);
    expect(locationOf(res)).toBe("http://localhost/dashboard");
    expect(locationOf(res)).not.toContain("error=");
  });

  // The other shape the same email can arrive in. Modern Supabase templates
  // use {{ .TokenHash }} and land on Path 2 rather than Path 1.
  it("sends a signed-in user into the app after a failed token-hash verify", async () => {
    mockSupabase({ user: signedInUser, exchangeFails: true });
    const res = await callbackGet(
      `http://localhost/auth/callback?token_hash=${MOCK_TOKEN_HASH}&type=signup`,
    );
    expect([302, 307]).toContain(res.status);
    expect(locationOf(res)).toBe("http://localhost/dashboard");
    expect(locationOf(res)).not.toContain("error=");
  });
});

describe("what must still fail", () => {
  // THE LIMIT OF THE FIX. A genuinely expired link with nobody signed in is a
  // real failure and must still say so -- the fall-through grants nothing, it
  // only asks a question that was not being asked.
  it("still errors when the link is spent and nobody is signed in", async () => {
    mockSupabase({ user: null, exchangeFails: true });
    const res = await callbackGet(
      `http://localhost/auth/callback?code=${MOCK_CODE}`,
    );
    expect([302, 307]).toContain(res.status);
    expect(locationOf(res)).toContain("/login?error=");
  });
});

describe("what must not have changed", () => {
  it("still sends a successful exchange into the app", async () => {
    mockSupabase({ user: signedInUser, exchangeFails: false });
    const res = await callbackGet(
      `http://localhost/auth/callback?code=${MOCK_CODE}`,
    );
    expect([302, 307]).toContain(res.status);
    expect(locationOf(res)).toBe("http://localhost/dashboard");
  });

  // THE OPEN REDIRECT. The new fall-through reaches the same redirectInto()
  // as every other path, so ?next= is still run through the safe-redirect
  // guard. A fix that let the backslash form through on the recovery path
  // would reintroduce the credential-phishing bug this project has already
  // had once.
  //
  // BACKSLASH BUILT FROM ITS CHARACTER CODE, not written as an escape. The
  // first version of this test wrote "/\evil.com" in a shell heredoc, which
  // collapsed it to "/" + "\e" -- and JS resolves that unknown escape to a
  // plain "e", so the test was quietly asserting against "/evil.com", an
  // ordinary same-origin path. It passed the guard, as it should, and the
  // test read as a security failure that was not one.
  const BACKSLASH = String.fromCharCode(92);

  it.each([
    ["protocol-relative", "//evil.com"],
    ["backslash form", `/${BACKSLASH}evil.com`],
    ["absolute url", "https://evil.com"],
  ])("still refuses an off-site ?next= (%s) on the fall-through path", async (
    _label,
    hostile,
  ) => {
    mockSupabase({ user: signedInUser, exchangeFails: true });
    const res = await callbackGet(
      `http://localhost/auth/callback?code=${MOCK_CODE}&next=${encodeURIComponent(hostile)}`,
    );
    // The property that matters is the ORIGIN, not the absence of a string: a
    // legitimate in-app path is allowed to contain "evil.com" and still be
    // perfectly safe.
    expect(new URL(locationOf(res)).origin).toBe("http://localhost");
    expect(locationOf(res)).toBe("http://localhost/dashboard");
  });

  it("still honours a same-origin ?next= on the fall-through path", async () => {
    mockSupabase({ user: signedInUser, exchangeFails: true });
    const res = await callbackGet(
      `http://localhost/auth/callback?code=${MOCK_CODE}&next=/scan-result`,
    );
    expect(locationOf(res)).toBe("http://localhost/scan-result");
  });
});
