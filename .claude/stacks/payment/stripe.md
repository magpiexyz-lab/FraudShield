---
assumes: [framework/nextjs]
packages:
  runtime: [stripe, "@stripe/stripe-js"]
  dev: []
files:
  - src/lib/stripe.ts
  - src/lib/stripe-client.ts
  - src/app/api/checkout/route.ts
  - src/app/api/webhooks/stripe/route.ts
env:
  server: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, NEXT_PUBLIC_SITE_URL]
  client: [NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY]
ci_placeholders:
  STRIPE_SECRET_KEY: placeholder-stripe-secret
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: placeholder-stripe-publishable
  STRIPE_WEBHOOK_SECRET: placeholder-stripe-webhook-secret
  NEXT_PUBLIC_SITE_URL: http://localhost:3000
clean:
  files: []
  dirs: []
gitignore: []
---
# Payment: Stripe
> Used when experiment.yaml has `stack.payment: stripe`

## Packages
```bash
npm install stripe @stripe/stripe-js
```

## Files to Create

### `src/lib/stripe.ts` — Server-side Stripe client
```ts
import Stripe from "stripe";

let _stripe: Stripe | null = null;

function createDemoStripe() {
  return {
    checkout: {
      sessions: {
        create: (params: Record<string, unknown>) =>
          Promise.resolve({ url: (params?.success_url as string) ?? "/" }),
      },
    },
    webhooks: {
      constructEvent: () => ({ type: "demo", data: { object: {} } }),
    },
  } as unknown as Stripe;
}

export function getStripe(): Stripe {
  if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return createDemoStripe();
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}
```
- The Stripe SDK automatically uses the API version bundled with the installed package. To pin a specific version, add `apiVersion` — see https://stripe.com/docs/upgrades.
- Import `getStripe` in API route handlers only — call it inside the handler function, not at module scope

### `src/lib/stripe-client.ts` — Client-side Stripe loader
```ts
import { loadStripe } from "@stripe/stripe-js";

const STRIPE_PUBLISHABLE_PLACEHOLDER = "placeholder-stripe-publishable";
const stripeKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || STRIPE_PUBLISHABLE_PLACEHOLDER;

// Issue #1170 follow-up: warn loudly when the placeholder fallback is hit on a
// deployed host. Stripe's `loadStripe()` does not surface a configuration error
// for an invalid publishable key — checkout silently fails when a user clicks
// "Pay" — so the warning has to come from this module at load time.
const isStripeMisconfigured = stripeKey === STRIPE_PUBLISHABLE_PLACEHOLDER;
const isDeployedHost =
  typeof window !== "undefined" &&
  !["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(window.location.hostname) &&
  !window.location.hostname.endsWith(".local");

if (isStripeMisconfigured && isDeployedHost && process.env.NEXT_PUBLIC_VERCEL_ENV !== "preview") {
  console.error(
    "[stripe-client] Stripe is not configured for this deployment — checkout will silently fail. " +
    "Set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY in your hosting platform (Vercel → Settings → " +
    "Environment Variables) to a real `pk_test_*` or `pk_live_*` publishable key."
  );
}

// Use `||` (falsy check) rather than `??` so empty-string env values (common on
// CI/Vercel when a var is declared but unset) fall back to the placeholder
// instead of initializing Stripe.js with "" and crashing at load time.
export const stripePromise = isStripeMisconfigured ? null : loadStripe(stripeKey);
```
- Use this in client components to redirect to Stripe Checkout. When `stripePromise` is `null`, callers should disable the checkout button (or short-circuit the redirect) — never call Stripe APIs with the placeholder.

## Environment Variables
```
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_SITE_URL=https://your-domain.com
```

## API Routes

### `src/app/api/checkout/route.ts` — Create Checkout Session
```ts
import { NextResponse } from "next/server";
import { z } from "zod";
import { getStripe } from "@/lib/stripe";
import { rateLimit } from "@/lib/rate-limit";

const checkoutSchema = z.object({
  // TODO: Replace z.string() with z.enum([...]) listing valid plan values for this project
  plan: z.string().max(200),
});

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const { success } = rateLimit(ip, { limit: 10, windowMs: 60_000 });
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  // TODO: Upgrade to Upstash Redis for cross-instance rate limiting
  try {
    const body = await request.json();
    const { plan } = checkoutSchema.parse(body);

    // TODO: Add auth check here — see auth stack file "Server-Side Auth Check" for the correct import
    // This defines `user`, whose `user.id` is referenced in metadata below

    // TODO: Look up price server-side — never trust client-provided prices
    // Define a PLAN_PRICES map or query the database for the plan's price
    // Example: const PLAN_PRICES: Record<string, number> = { basic: 999, pro: 2999 };
    const amount_cents = PLAN_PRICES[plan]; // Intentional — fails build until PLAN_PRICES is defined (see TODO above)

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: { name: plan },
            unit_amount: amount_cents,
          },
          quantity: 1,
        },
      ],
      metadata: {
        user_id: user.id, // Intentional — fails build until auth is wired (see TODO above)
        plan,
        amount_cents: String(amount_cents),
      },
      success_url: `${siteUrl}/`,
      cancel_url: `${siteUrl}/`,
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    return NextResponse.json({ error: "Checkout failed" }, { status: 500 });
  }
}
```

Notes:
- Rate limiting: the template includes an in-memory burst limiter (`rateLimit` from `@/lib/rate-limit`). See the hosting stack file for the rate limiter implementation.
- Validates request body with zod (plan name)
- Creates a Stripe Checkout Session in `payment` mode (change to `subscription` for recurring)
- Sets `success_url` and `cancel_url` using `NEXT_PUBLIC_SITE_URL` environment variable with a `localhost:3000` fallback when the var is absent — never use client-controlled headers for redirect URLs
- Returns the session URL to the client
- If `stack.analytics` is present: fire `pay_start` analytics event before redirecting — use the typed `trackPayStart()` wrapper from `events.ts` (client-side, before calling this route). Skip if analytics is absent.
- The `user.id` reference is intentionally undefined in the template — it causes a build error until auth is integrated. See the auth stack file's "Server-Side Auth Check" section for the correct import and guard pattern. The `metadata` object is critical — the webhook handler reads `session.metadata.user_id` to update the database.
- The `PLAN_PRICES[plan]` reference is intentionally undefined — it causes a build error until server-side pricing is implemented. Define a price map or query the database. Never accept prices from the client (see Security section). The `amount_cents` value flows into session metadata and is read by the webhook handler.

### `src/app/api/webhooks/stripe/route.ts` — Stripe Webhook Handler

When `stack.analytics` is absent: remove the `@/lib/analytics-server` import and the `await trackServerEvent()` call from the template below. The webhook will still process payments correctly without analytics.

The template uses **INSERT + catch PG `23505`** for idempotency (see `supabase/migrations/xxx_stripe_events.sql` below). Stripe delivers at-least-once; a SELECT-then-INSERT check is a TOCTOU race that can double-process the same event under concurrent delivery. The UNIQUE constraint on `stripe_event_id` + the catch of the `23505` unique-violation error code is atomic and safe by default.

```ts
import { NextResponse } from "next/server";
import { getStripe } from "@/lib/stripe";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { trackServerEvent } from "@/lib/analytics-server";
import { rateLimit } from "@/lib/rate-limit";

export async function POST(request: Request) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const { success } = rateLimit(ip, { limit: 30, windowMs: 60_000 });
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  // TODO: Upgrade to Upstash Redis for cross-instance rate limiting
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Idempotency guard: INSERT + catch PG 23505 (unique_violation).
  // This is atomic — two concurrent deliveries of the same event_id will
  // produce exactly one successful insert; the other receives 23505 and
  // exits early with 200 so Stripe does not retry.
  const supabase = createServiceRoleClient();
  const { error: insertErr } = await supabase
    .from("stripe_events")
    .insert({ stripe_event_id: event.id });
  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      return NextResponse.json({ received: true });
    }
    return NextResponse.json({ error: "Persistence error" }, { status: 500 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.metadata?.user_id ?? "unknown";
    // TODO: Update user's payment status in database using userId

    await trackServerEvent("pay_success", userId, {
      plan: session.metadata?.plan ?? "",
      amount_cents: Number(session.metadata?.amount_cents ?? 0),
      provider: "stripe",
    });
  }

  return NextResponse.json({ received: true });
}
```

#### Idempotency migration (`supabase/migrations/<N>_stripe_events.sql`)

```sql
create table if not exists stripe_events (
  stripe_event_id text primary key,
  received_at timestamptz not null default now()
);

-- Only the service role writes to this table (webhook handler uses createServiceRoleClient).
-- No RLS-exposed access from clients.
alter table stripe_events enable row level security;

drop policy if exists "service role writes stripe events" on stripe_events;
create policy "service role writes stripe events"
  on stripe_events
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
```

The primary key on `stripe_event_id` is what makes the INSERT+catch-23505 pattern atomic — PostgreSQL rejects the second insert with `23505` (`unique_violation`) inside the same transaction window as the first.

Notes:
- Rate limiting: the template includes an in-memory burst limiter with a higher limit (30/min vs 10/min for checkout) since webhooks may receive bursts from Stripe. See the hosting stack file and the checkout route notes above.
- Reads the raw request body (do NOT parse JSON before verification)
- Verifies the webhook signature using `STRIPE_WEBHOOK_SECRET`
- Handles `checkout.session.completed` event: should update payment status (see TODO in template) and fires `pay_success` server-side via `trackServerEvent()` with all required experiment/EVENTS.yaml properties (`plan`, `amount_cents`, `provider`)
- The `// TODO: Update user's payment status in database` compiles silently — unlike the checkout route's `user.id` reference which fails the build. You must implement the database update using the `userId` extracted from session metadata before the payment flow is complete. Without this, successful payments are not recorded.
- Extracts `user_id`, `plan`, and `amount_cents` from session metadata (set during checkout creation)
- Returns `200` for all event types (don't error on unknown events)

## Production Observability

When `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is missing or empty, `src/lib/stripe-client.ts` falls back to the literal placeholder `placeholder-stripe-publishable`. Stripe's `loadStripe()` does NOT surface a configuration error for an invalid publishable key — checkout silently fails when the user clicks "Pay" — so the misconfiguration is invisible until a real conversion attempt fails.

**Fail-loud mechanism (issue #1170 follow-up):** `stripe-client.ts` performs a module-load `console.error` when the placeholder is in use AND the page is running on a deployed host (hostname not in `["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]`, not `*.local`, and not a Vercel preview build). When misconfigured, `stripePromise` is exported as `null`; client components MUST treat a `null` promise as "checkout disabled" — never call Stripe APIs through it.

This warning surfaces at first page load, before any user clicks "Pay", giving operators time to set the correct `pk_test_*` / `pk_live_*` value in the hosting platform.

The server-side `getStripe()` factory in `src/lib/stripe.ts` already throws when `STRIPE_SECRET_KEY` is missing (line 60-62) — that path is loud by design. Only the client-side publishable key needed the additional surfacing.

## Patterns
- Use **Stripe Checkout** (hosted payment page) — never handle raw card data
- Fire `pay_start` when redirecting the user to Checkout
- Fire `pay_success` in the webhook handler (server-side confirmation)
- Always verify webhook signatures — reject requests with invalid signatures
- Use `metadata` on the Checkout Session to pass `user_id` for database updates in the webhook

## Security
- Never expose `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` to the client
- Always verify webhook signatures before processing events
- Use the server-side Stripe client (`stripe.ts`) only in API routes
- Validate all amounts and plan names server-side — never trust client-provided prices

## Analytics Integration
- `pay_start`: fire client-side when the client receives the Checkout URL and redirects — use the typed `trackPayStart()` wrapper from `events.ts` (per CLAUDE.md Rule 2)
- `pay_success`: fired server-side in the webhook handler via `trackServerEvent()` from `analytics-server.ts` after confirming `checkout.session.completed` — includes all required properties (`plan`, `amount_cents`, `provider`)
- See experiment/EVENTS.yaml for the full property spec for both events

## Stack Knowledge

### When deduplicating Stripe webhook replays, use INSERT + catch PG `23505` (already baked into the template)
Stripe delivers at-least-once, so webhook replays are expected. The route template above uses the correct pattern: `INSERT INTO stripe_events(stripe_event_id)` and catch PostgreSQL error code `23505` (unique_violation) as a successful no-op. **Do NOT rewrite this as a SELECT-then-INSERT check** — that is a Time-of-Check-Time-of-Use (TOCTOU) race: two concurrent deliveries of the same event ID can both pass the SELECT and both INSERT, causing duplicate side-effects (double payment processing, double `trackServerEvent("pay_success")`). The INSERT + catch-`23505` pattern is atomic at the database level via the `PRIMARY KEY` on `stripe_event_id`; keep it.

### When a Stripe key appears as a literal in a test fixture, avoid the sk_test_ / pk_test_ prefix
Hardcoded values like `sk_test_demo`, `sk_test_abc123`, or any string beginning with `sk_test_` / `pk_test_` trigger secret-scanning false positives in CI, in `gitleaks`-style audits, and in GitHub's push-protection secret-scanning. The scanners match the Stripe key prefix pattern regardless of whether the value is a real key. Use a descriptive placeholder that does NOT match the Stripe key format — prefer the `placeholder-stripe-*` family already declared in this stack's frontmatter `ci_placeholders` slot for self-consistency.

```ts
// WRONG — `sk_test_` prefix triggers secret-scanning FPs
process.env.STRIPE_SECRET_KEY = "sk_test_demo";
process.env.STRIPE_SECRET_KEY = "sk_test_abc123";

// CORRECT — re-use the placeholder name declared in the stack frontmatter
process.env.STRIPE_SECRET_KEY = "placeholder-stripe-secret";
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "placeholder-stripe-publishable";
process.env.STRIPE_WEBHOOK_SECRET = "placeholder-stripe-webhook-secret";
```

This applies to ALL test files (Vitest, Jest, Playwright global setup) that hardcode a mock Stripe key, and to any inline docs/README code samples. The stack file's own `loadStripe` fallback near the top of this file already uses the safe `placeholder-stripe-publishable` — do the same for fixtures.

### Never use client-submitted bounds for amount validation — re-read authoritative values from the database
API routes that accept client-submitted numeric bounds (price ranges, discount bounds, quantity limits, quote-tier floors/ceilings) and use those bounds to validate or clamp a final value are vulnerable to fraud: the client controls both the submitted value AND the bounds it is validated against. A client can submit `{range_low: 0, range_high: 1e9, final: 1}` and bypass the intended tier constraints entirely. The authoritative bounds must be sourced from the database (server-computed values tied to a user/tier/product), not from the request body.

```typescript
// WRONG — client-submitted bounds used for CLAMP validation
const { range_low, range_high, final } = await req.json();
if (final < range_low || final > range_high) return error();  // client controls both sides

// CORRECT — re-read authoritative bounds from DB keyed on a server-known entity
const { quoteId, final } = await req.json();
const { range_low, range_high } = await db.quotes.findOne({ id: quoteId, userId });
if (final < range_low || final > range_high) return error();  // bounds come from DB
```

This applies to checkout confirm routes, quote confirm/finalize routes, admin amount-adjust routes, discount-apply routes, and any route where a client posts a numeric value alongside its own "intended range." The pattern also applies to non-Stripe payment flows — it is the general principle for server-authoritative numeric constraints. The Zod schema can still validate shape (`range_low: z.number().nonnegative()`) but must not validate the relationship between client fields; the relationship check must use server-sourced bounds.

### When NEXT_PUBLIC_SITE_URL is missing, Stripe checkout redirect URLs become "undefined/path"
The checkout route template uses a `localhost:3000` fallback when building Stripe redirect URLs. Without it, the env var evaluates to `undefined` and produces `undefined/dashboard/setup` — a URL Stripe accepts silently, causing post-payment redirects to fail. The fallback is a defensive measure for local development before `NEXT_PUBLIC_SITE_URL` is configured. In production, the env var should always be set.

```typescript
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
success_url: `${siteUrl}/`,
cancel_url: `${siteUrl}/`,
```

## PR Instructions
- After merging, set these environment variables in your hosting provider:
  - `STRIPE_SECRET_KEY` — from Stripe Dashboard > Developers > API keys
  - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` — from Stripe Dashboard > Developers > API keys
  - `STRIPE_WEBHOOK_SECRET` — from Stripe Dashboard > Developers > Webhooks (create a webhook endpoint pointing to `https://your-domain/api/webhooks/stripe`)
- Configure the Stripe webhook to listen for `checkout.session.completed` events
