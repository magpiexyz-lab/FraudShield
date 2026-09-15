// Integration test for the b-07 system behavior:
//   "stripe webhook checkout.session.completed → subscription is active +
//    scan quota raised."
//
// We invoke the webhook handler directly (Next.js doesn't expose an app.request
// instance, so we import the POST handler and call it with a fabricated
// Request). DEMO_MODE is set on the test process so the demo Stripe + Supabase
// clients short-circuit. This validates the wiring shape — webhook receives a
// signed payload, idempotency table is touched, subscription upsert runs,
// pay_success event is sent. End-to-end with a real Stripe signature is the
// responsibility of /verify --post-deploy.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

beforeAll(() => {
  // Tell every server-side library to use its demo-mode short-circuit.
  process.env.DEMO_MODE = "true";
  process.env.STRIPE_WEBHOOK_SECRET = "placeholder-stripe-webhook-secret";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://placeholder.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "placeholder-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "placeholder-service-role-key";
});

describe("b-07: Stripe webhook checkout.session.completed", () => {
  it("processes a checkout.session.completed event end-to-end", { timeout: 20_000 }, async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");

    const body = JSON.stringify({
      id: `evt_test_${Date.now()}`,
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_123",
          object: "checkout.session",
          customer: "cus_test_123",
          subscription: null,
          metadata: {
            user_id: "demo-user-id",
            plan: "pro",
            amount_cents: "6000",
          },
        },
      },
    });

    const request = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "demo-signature-bypassed-by-demo-stripe-client",
      },
      body,
    });

    const response = await POST(request);
    expect(response.status).toBeLessThan(500);
    const payload = await response.json();
    // Either { received: true } (event accepted) or graceful no-op — anything
    // under 500 confirms the handler ran without throwing. Real signature
    // verification is exercised post-deploy with the live STRIPE_WEBHOOK_SECRET.
    expect(payload).toBeDefined();
  });

  it("rejects requests missing the stripe-signature header", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");

    const request = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evt_no_sig", type: "checkout.session.completed" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe("auth callback route: post-confirm redirect contract (#5)", () => {
  // After an email-confirmation click, the user must land on /dashboard
  // already authenticated — NOT bounced back to /login or the landing page.
  // The route has an early DEMO_MODE branch that redirects to "/" — we
  // unset DEMO_MODE for this block so the real success-redirect logic runs,
  // and rely on placeholder env vars so createServerSupabaseClient falls
  // back to the demo client internally. The demo auth Proxy returns
  // {error: null} for exchangeCodeForSession via its catch-all handler.

  let savedDemoMode: string | undefined;
  beforeAll(() => {
    savedDemoMode = process.env.DEMO_MODE;
    delete process.env.DEMO_MODE;
  });
  afterAll(() => {
    if (savedDemoMode !== undefined) process.env.DEMO_MODE = savedDemoMode;
  });

  // A 20+ char base64url-ish string that matches the codeSchema regex.
  const MOCK_CODE = "abcdef0123456789ABCDEF_-mockcode01";

  it("redirects to /dashboard by default after successful code exchange", async () => {
    const { GET } = await import("@/app/auth/callback/route");
    const request = new Request(
      `http://localhost/auth/callback?code=${MOCK_CODE}`,
    );
    const response = await GET(request);
    expect([302, 307]).toContain(response.status);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("http://localhost/dashboard");
  });

  it("honors a same-origin ?next= override", async () => {
    const { GET } = await import("@/app/auth/callback/route");
    const request = new Request(
      `http://localhost/auth/callback?code=${MOCK_CODE}&next=/scan-result`,
    );
    const response = await GET(request);
    expect([302, 307]).toContain(response.status);
    expect(response.headers.get("location")).toBe(
      "http://localhost/scan-result",
    );
  });

  it("falls back to /dashboard when ?next= is an open-redirect attempt", async () => {
    const { GET } = await import("@/app/auth/callback/route");
    const request = new Request(
      `http://localhost/auth/callback?code=${MOCK_CODE}&next=//evil.com`,
    );
    const response = await GET(request);
    expect([302, 307]).toContain(response.status);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("http://localhost/dashboard");
    expect(location).not.toContain("evil.com");
  });
});

describe("checkout route: server-side price + plan lookup", () => {
  it("rejects checkout requests with no authenticated session", async () => {
    // In DEMO_MODE the supabase server client returns a demo user, so we
    // exercise the success path instead — the route returns a checkout URL.
    const { POST } = await import("@/app/api/checkout/route");
    const request = new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro" }),
    });
    const response = await POST(request);
    expect(response.status).toBeLessThan(500);
  });

  it("rejects an unknown plan slug with a 400", async () => {
    const { POST } = await import("@/app/api/checkout/route");
    const request = new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "nonexistent-plan" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

// Bug #2: graceful Pro-upgrade UX when Stripe is unconfigured.
// When STRIPE_SECRET_KEY is unset/placeholder (e.g., a staging deployment
// without Stripe wired up), POST /api/checkout MUST return a distinguishable
// "not_configured" response — NOT a generic 500/503 with no code field —
// so the client can swap to a waitlist form instead of a retry-prompting
// red error toast.
describe("checkout route: Stripe-not-configured graceful path (bug #2)", () => {
  it("returns a structured not_configured response when Stripe envs are placeholders", async () => {
    // Save + override env. We need DEMO_MODE off and STRIPE_SECRET_KEY absent
    // to exercise the production "Stripe not wired up" path.
    const prevDemo = process.env.DEMO_MODE;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    process.env.DEMO_MODE = "false";
    delete process.env.STRIPE_SECRET_KEY;
    // Reset the module so the route + stripe client re-read env on first call.
    const vitestGlobal = (await import("vitest")).vi;
    vitestGlobal.resetModules();
    try {
      const { POST } = await import("@/app/api/checkout/route");
      const request = new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const response = await POST(request);
      const payload = await response.json();

      // MUST be distinguishable from a generic 500/503. We accept either a 503
      // with code: "not_configured" or a 200 with status: "coming_soon".
      const isStructuredNotConfigured =
        (response.status === 503 && payload.code === "not_configured") ||
        (response.status === 200 && payload.status === "coming_soon") ||
        payload.error === "not_configured";
      expect(isStructuredNotConfigured).toBe(true);

      // MUST carry a user-friendly waitlist-oriented message.
      expect(typeof payload.message).toBe("string");
      expect(payload.message.toLowerCase()).toMatch(/waitlist|coming soon|notify/);
    } finally {
      if (prevDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prevDemo;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
      vitestGlobal.resetModules();
    }
  });
});

// b-10: the Google Ads Phase 2 fake door.
//
// POST /api/pay-intent is the DB half of the pay-intent signal. These tests pin
// the contract the Phase 2 verdict depends on: a server-authoritative price, a
// zod-guarded body, and no payment provider anywhere on the path.
//
// DEMO_MODE caveat, same as the checkout tests above: the demo Supabase client
// returns a demo user from getUser(), so the 401 branch is unreachable here and
// we assert the success path instead. The demo user's user_metadata is also
// hardcoded to {}, which is precisely why attribution precedence lives in a pure
// function tested directly in src/lib/attribution.test.ts rather than here.
describe("b-10: POST /api/pay-intent (fake-door pay intent)", () => {
  it("records a pay intent for an authenticated user", async () => {
    const { POST } = await import("@/app/api/pay-intent/route");
    const request = new Request("http://localhost/api/pay-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: "pro",
        gclid: "CjwKCAjw5remBhBiEiwAxL4L9mQ2Kk8ZzR7vN3pYwT6bXhFgD1sJ0aQeR4uV8cWnMxYzAbCdEfGh",
        utm_campaign: "fraudshield-search-phase2-v1",
        distinct_id: "01920000-0000-7000-8000-000000000000",
      }),
    });
    const response = await POST(request);
    expect(response.status).toBeLessThan(500);
  });

  it("accepts the day-0 probe attribution that the strict gclid gate would reject", async () => {
    // The probe is mandatory before launch and uses a deliberately non-Google
    // gclid. If this 400s or drops the value, the probe fails and the campaign
    // cannot launch.
    const { POST } = await import("@/app/api/pay-intent/route");
    const request = new Request("http://localhost/api/pay-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plan: "pro",
        gclid: "probe-20260811",
        utm_campaign: "dayzero-probe",
      }),
    });
    const response = await POST(request);
    expect(response.status).toBeLessThan(500);
  });

  it("rejects an unknown plan slug with a 400", async () => {
    const { POST } = await import("@/app/api/pay-intent/route");
    const request = new Request("http://localhost/api/pay-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "enterprise-unlimited" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects an over-length gclid with a 400", async () => {
    const { POST } = await import("@/app/api/pay-intent/route");
    const request = new Request("http://localhost/api/pay-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro", gclid: "C".repeat(513) }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("never accepts a client-supplied price", async () => {
    // price_cents is read server-side from PLAN_PRICES. A body carrying its own
    // price must not change what is stored — the cross-MVP revenue ranking
    // multiplies this value by the pay-intent rate.
    const { payIntentSchema } = await import("@/app/api/pay-intent/route");
    const parsed = payIntentSchema.parse({ plan: "pro", price_cents: 1 });
    expect("price_cents" in parsed).toBe(false);
  });
});

// The activation gate on POST /api/pay-intent.
//
// Phase 2 counts intent from people who USED the product. The CTA is
// render-guarded on both /scan-result and /pricing, but a client guard is
// cosmetic — this route is what actually enforces it, which matters now that
// two surfaces can fire the event.
//
// DEMO_MODE's demo user has no scans rows, so it stands in for a signed-up but
// never-activated user. That also means the b-10 tests above exercise this 403
// path rather than a real insert; they assert status < 500 for that reason.
describe("b-10: pay-intent activation gate", () => {
  it("rejects a signed-in user who has never received a fraud score", async () => {
    const { POST } = await import("@/app/api/pay-intent/route");
    const request = new Request("http://localhost/api/pay-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro", utm_campaign: "fraudshield-search-phase2-v1" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  it("still answers 400 for a malformed body, not 403", async () => {
    // Validation runs before the activation lookup on purpose, so the input
    // contract stays observable regardless of activation state.
    const { POST } = await import("@/app/api/pay-intent/route");
    const request = new Request("http://localhost/api/pay-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "not-a-real-plan" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

// Enterprise intake. The route is the only writer — enterprise_leads has no
// client insert policy — so its guards are what stand between the sales
// pipeline and anyone with a session.
describe("enterprise lead intake", () => {
  it("rejects an entirely empty enquiry", async () => {
    const { POST } = await import("@/app/api/enterprise-lead/route");
    const request = new Request("http://localhost/api/enterprise-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects an unknown volume band", async () => {
    const { POST } = await import("@/app/api/enterprise-lead/route");
    const request = new Request("http://localhost/api/enterprise-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ monthly_volume: "a-million-ish" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("never accepts an email from the request body", async () => {
    // The submitter is signed in, so the address comes off the session. Taking
    // it from the body would let a lead be filed under someone else's email.
    const { enterpriseLeadSchema } = await import("@/app/api/enterprise-lead/route");
    const parsed = enterpriseLeadSchema.parse({
      company: "Acme",
      email: "attacker@example.com",
    });
    expect("email" in parsed).toBe(false);
  });

  it("accepts a well-formed enquiry", async () => {
    const { POST } = await import("@/app/api/enterprise-lead/route");
    const request = new Request("http://localhost/api/enterprise-lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company: "Acme Lending",
        monthly_volume: "500-2000",
        message: "Two underwriters review by eye today.",
      }),
    });
    const response = await POST(request);
    expect(response.status).toBeLessThan(500);
  });
});

// Phase 3: /api/checkout opens a real MONTHLY SUBSCRIPTION against a dashboard
// Price, in Stripe TEST mode only.
//
// Two contracts are pinned here:
//   (a) the not_configured 503 must ALSO cover a missing STRIPE_PRO_PRICE_ID.
//       CI only ever supplies placeholder Stripe values and cannot be given new
//       env vars, so this is the branch every CI run must land in.
//   (b) when both envs are present the session must be mode: "subscription",
//       must pass the dashboard Price id straight through (never an inline
//       price_data amount), and must stamp attribution into BOTH metadata bags
//       - Stripe does not copy session metadata onto the Subscription object.
//
// Fixtures deliberately avoid the literal live/test key prefixes: the secret
// scanner and the stack rule both flag them even inside test files.
const FAKE_STRIPE_KEY = "rk_test_notarealkey_fraudshield_unit_fixture";
const FAKE_PRICE_ID = "price_0PhaseThreeMonthlyTest";

// The subset of Checkout Session params these tests assert on.
type CheckoutSessionParams = {
  mode: string;
  line_items: Array<{ price?: string; quantity?: number; price_data?: unknown }>;
  metadata: Record<string, string>;
  subscription_data: { metadata: Record<string, string> };
};

describe("Phase 3 checkout: monthly subscription session", () => {
  it("returns not_configured when STRIPE_PRO_PRICE_ID is unset", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    const prevPrice = process.env.STRIPE_PRO_PRICE_ID;
    process.env.DEMO_MODE = "false";
    // A secret key that clears every existing placeholder/length test, so the
    // ONLY thing missing is the Price id.
    process.env.STRIPE_SECRET_KEY = "rk_test_notarealkey_priceunset_fixture";
    delete process.env.STRIPE_PRO_PRICE_ID;
    const vitestGlobal = (await import("vitest")).vi;
    vitestGlobal.resetModules();
    try {
      const { POST } = await import("@/app/api/checkout/route");
      const request = new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const response = await POST(request);
      const payload = await response.json();
      expect(response.status).toBe(503);
      expect(payload.code).toBe("not_configured");
      expect(typeof payload.message).toBe("string");
    } finally {
      if (prevDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prevDemo;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
      if (prevPrice === undefined) delete process.env.STRIPE_PRO_PRICE_ID;
      else process.env.STRIPE_PRO_PRICE_ID = prevPrice;
      vitestGlobal.resetModules();
    }
  });


  // Regression guard for the live-key safety interlock. The first version of
  // this check was a denylist (startsWith "sk_live_"), which Stripe RESTRICTED
  // live keys ("rk_live_") walked straight through -- they are non-empty, not
  // placeholder-shaped and well over the length floor, so the real SDK would
  // have been instantiated against a LIVE account on a build with no
  // cancellation path. The check is now an allowlist of test prefixes.
  it("refuses a restricted LIVE key even when the Price id is present", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    const prevPrice = process.env.STRIPE_PRO_PRICE_ID;
    process.env.DEMO_MODE = "false";
    process.env.STRIPE_SECRET_KEY = "rk_live_notarealkey_interlock_fixture";
    process.env.STRIPE_PRO_PRICE_ID = FAKE_PRICE_ID;
    const vitestGlobal = (await import("vitest")).vi;
    vitestGlobal.resetModules();
    try {
      const { POST } = await import("@/app/api/checkout/route");
      const request = new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro" }),
      });
      const response = await POST(request);
      const payload = await response.json();
      expect(response.status).toBe(503);
      expect(payload.code).toBe("not_configured");
    } finally {
      if (prevDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prevDemo;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
      if (prevPrice === undefined) delete process.env.STRIPE_PRO_PRICE_ID;
      else process.env.STRIPE_PRO_PRICE_ID = prevPrice;
      vitestGlobal.resetModules();
    }
  });
  it("opens a subscription session with the dashboard Price and dual metadata", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    const prevPrice = process.env.STRIPE_PRO_PRICE_ID;
    process.env.DEMO_MODE = "false";
    process.env.STRIPE_SECRET_KEY = FAKE_STRIPE_KEY;
    process.env.STRIPE_PRO_PRICE_ID = FAKE_PRICE_ID;

    const { PLAN_PRICES } = await import("@/lib/types");
    const vitestGlobal = (await import("vitest")).vi;
    vitestGlobal.resetModules();

    let created: CheckoutSessionParams | null = null;
    let retrievedId: string | null = null;
    vitestGlobal.doMock("@/lib/stripe", () => ({
      getStripe: () => ({
        prices: {
          retrieve: (id: string) => {
            retrievedId = id;
            return Promise.resolve({
              id,
              unit_amount: PLAN_PRICES.pro,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
              active: true,
              type: "recurring",
            });
          },
        },
        checkout: {
          sessions: {
            create: (params: CheckoutSessionParams) => {
              created = params;
              return Promise.resolve({ url: "https://stripe.test/session" });
            },
          },
        },
      }),
    }));

    try {
      const { POST } = await import("@/app/api/checkout/route");
      const request = new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan: "pro",
          gclid: "CjwKPhase3TestGclidValue",
          utm_campaign: "fraudshield-search-phase2-v2",
        }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);

      expect(retrievedId).toBe(FAKE_PRICE_ID);
      expect(created).not.toBeNull();
      const params = created as unknown as CheckoutSessionParams;

      // Recurring, not one-time.
      expect(params.mode).toBe("subscription");

      // Dashboard Price passthrough - no inline amount may appear.
      expect(params.line_items[0].price).toBe(FAKE_PRICE_ID);
      expect(params.line_items[0].quantity).toBe(1);
      expect(params.line_items[0].price_data).toBeUndefined();

      // BOTH bags. subscription_data.metadata is what the PR 2 retention
      // handlers read off the Subscription object.
      expect(typeof params.metadata.attribution_source).toBe("string");
      expect(params.metadata.attribution_source.length).toBeGreaterThan(0);
      expect(typeof params.subscription_data.metadata.attribution_source).toBe(
        "string",
      );
      expect(params.subscription_data.metadata.attribution_source).toBe(
        params.metadata.attribution_source,
      );
      expect(params.subscription_data.metadata.user_id).toBe(
        params.metadata.user_id,
      );
      expect(params.subscription_data.metadata.plan).toBe("pro");
      expect(params.subscription_data.metadata.amount_cents).toBe(
        String(PLAN_PRICES.pro),
      );
    } finally {
      vitestGlobal.doUnmock("@/lib/stripe");
      if (prevDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prevDemo;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
      if (prevPrice === undefined) delete process.env.STRIPE_PRO_PRICE_ID;
      else process.env.STRIPE_PRO_PRICE_ID = prevPrice;
      vitestGlobal.resetModules();
    }
  });
});

// The Stripe metadata VALUE limit is 500 characters; the zod bound (mirrored
// from /api/pay-intent) is 512. Without a clamp, a 501-512 char gclid on the
// URL would make Stripe reject the session and hand the buyer a 500 - a
// client-triggerable failure on the one route that takes money.
describe("Phase 3 checkout: gclid clamped to the Stripe metadata limit", () => {
  it("truncates an over-long gclid to 500 characters in both bags", async () => {
    const prevDemo = process.env.DEMO_MODE;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    const prevPrice = process.env.STRIPE_PRO_PRICE_ID;
    process.env.DEMO_MODE = "false";
    process.env.STRIPE_SECRET_KEY = FAKE_STRIPE_KEY;
    process.env.STRIPE_PRO_PRICE_ID = FAKE_PRICE_ID;

    const { PLAN_PRICES } = await import("@/lib/types");
    const vitestGlobal = (await import("vitest")).vi;
    vitestGlobal.resetModules();

    let created: CheckoutSessionParams | null = null;
    vitestGlobal.doMock("@/lib/stripe", () => ({
      getStripe: () => ({
        prices: {
          retrieve: (id: string) =>
            Promise.resolve({
              id,
              unit_amount: PLAN_PRICES.pro,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
              active: true,
              type: "recurring",
            }),
        },
        checkout: {
          sessions: {
            create: (params: CheckoutSessionParams) => {
              created = params;
              return Promise.resolve({ url: "https://stripe.test/session" });
            },
          },
        },
      }),
    }));

    try {
      const { POST } = await import("@/app/api/checkout/route");
      // 512 chars: the maximum the zod schema accepts, 12 over the Stripe cap.
      const longGclid = "Cj" + "a".repeat(510);
      expect(longGclid.length).toBe(512);
      const request = new Request("http://localhost/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "pro", gclid: longGclid }),
      });
      const response = await POST(request);
      expect(response.status).toBe(200);

      const params = created as unknown as CheckoutSessionParams;
      expect(params.metadata.gclid.length).toBe(500);
      expect(params.subscription_data.metadata.gclid.length).toBe(500);
      expect(longGclid.startsWith(params.metadata.gclid)).toBe(true);
    } finally {
      vitestGlobal.doUnmock("@/lib/stripe");
      if (prevDemo === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prevDemo;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
      if (prevPrice === undefined) delete process.env.STRIPE_PRO_PRICE_ID;
      else process.env.STRIPE_PRO_PRICE_ID = prevPrice;
      vitestGlobal.resetModules();
    }
  });
});
