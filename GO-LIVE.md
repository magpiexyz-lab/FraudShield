# FraudShield — go-live checklist

Everything that must be true before the first real customer is charged $60.

This file is the checklist because `.runs/deploy-manifest.json` cannot be: `.runs/`
is gitignored, so the manifest exists only on the machine that ran `/deploy` and
nobody else can read it. This is committed, diffable, and reviewable in a PR.

**Order matters.** Line 1 is last on launch day; lines 2–4 gate whether launch day
happens at all.

---

## 1. Remove the live-key safety block — LAUNCH DAY ONLY, DONE TOGETHER

**Status:** deliberately NOT done. Keep it this way until the launch step.

`src/app/api/checkout/route.ts` refuses any Stripe key that is not a test key:

```ts
// ALLOWLIST, not a denylist: Stripe restricted live keys begin "rk_live_",
// which a "sk_live_" prefix check would miss entirely.
const liveKeyInterlock =
  !!stripeKey &&
  !(stripeKey.startsWith("sk_test_") || stripeKey.startsWith("rk_test_"));
const stripeNotConfigured =
  !demoMode && (keyNotConfigured || priceNotConfigured || liveKeyInterlock);
```

**What this means in practice.** Putting a live key in Vercel without removing this
branch does not produce an error anyone will notice — checkout returns
`not_configured` and customers see the upgrade button do nothing. A silent failure
on the revenue path is worse than a loud one, so the removal has to be a deliberate
step someone performs, not a side effect of rotating an environment variable.

**On launch day, in this order:**

1. Remove the `liveKeyInterlock` branch, in its own PR, reviewed.
2. Merge and wait for the Vercel production deploy to report **Ready**.
3. Swap `STRIPE_SECRET_KEY` and `STRIPE_PRICE_ID` to live values in Vercel.
4. Point the Stripe webhook at the live endpoint and copy the new
   `STRIPE_WEBHOOK_SECRET` into Vercel — **the live endpoint has a different
   signing secret than the test one.** A stale secret means every webhook fails
   signature verification and no subscription is ever activated.
5. Confirm the live webhook subscribes to all **five** events:
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.deleted`, `customer.subscription.updated`.
   The fifth was missing in test and cost us a full debugging cycle.
6. Buy once with a real card. Confirm `subscription_activated` in PostHog and a
   row in `public.subscriptions` with `price_cents = 6000`. Refund it.

The Price validation in the same route stays regardless: it refuses to open a
session unless the Stripe Price is USD, recurring, monthly, interval_count 1, and
matches `PLAN_PRICES.pro`. That guard is not part of this step.

---

## 2. Detection accuracy gate

**Status:** not started. Tracked in
[issue #49](https://github.com/magpiexyz-lab/FraudShield/issues/49).

40 labelled documents — 20 genuine-style, 20 tampered with one known change each —
run through the product as a customer would, reported as one confusion matrix.

| Measure | Bar |
|---|---|
| Caught rate (recall on tampered) | ≥ 80% |
| False-alarm rate (on genuine) | ≤ 10% |

**Below the bar, launch is not blocked but the copy changes:** the landing page and
`/terms` must say the score is an aid rather than a determination, and the result
must show specific findings instead of a single number. Then re-run. Charging for
a product is fine once the claim matches what it does.

> **Open question before this starts — storage.** This repository is **public**.
> Issue #49 asks for the documents under `fraud-eval/`, but 20 of them are forged
> financial documents, including four from commercial fake-pay-stub sites and three
> built specifically to defeat metadata forensics. Committing them publishes a
> working set of forgery templates alongside a labelled map of what evades
> detection. Recommend keeping `labels.csv` and the results in the repo and the
> document files out of it, or generating content that is obviously synthetic
> (fictional employers, reserved identifiers) so the files are useless as
> templates. **To be settled before the set is built.**

---

## 3. Renewal events proven

**Status:** in progress.

Three of the five payment events are verified end to end against the live test-mode
endpoint:

| Event | Verified |
|---|---|
| `checkout_started` | yes |
| `subscription_activated` | yes |
| `subscription_canceled` | yes — 2026-09-29 |
| `invoice_paid` | pending — Stripe test clock |
| `payment_failed` | pending — Stripe test clock |

The last two never fire on a first purchase, by design:

```ts
const isRenewal = invoice.billing_reason !== "subscription_create";
if (subscriptionId && isRenewal) { ... }
```

Without that gate every new sale would be counted twice, once as a sale and once as
a renewal. Proving them therefore requires a forced renewal via a Stripe test clock.

Paste the two PostHog event ids here when done:

- `invoice_paid`: _pending_
- `payment_failed`: _pending_

---

## 4. CI is not currently a safety net

**Status:** known, filed with the fleet, not blocking.

The `build` job fails on `npm ci`, so `e2e` and `migrate` never run and migrations
are applied by hand.

```
npm ci can only install packages when your package.json and
package-lock.json are in sync
Invalid: lock file's picomatch@2.3.2 does not satisfy picomatch@4.0.7
```

**Cause.** `package-lock.json` was written by npm 11. CI pins Node 20 through
`.nvmrc`, which ships npm 10.8.2, and npm 10 reads npm 11's tree as inconsistent.
Regenerating the lockfile under npm 10 is not a fix — it was attempted in PR #46 and
pruned the Linux-only optional binaries (`@esbuild/linux-x64`,
`@tailwindcss/oxide-linux-x64-*`, `lightningcss-linux-x64-*`), which broke the build
a different way.

- Failing run:
  https://github.com/magpiexyz-lab/FraudShield/actions/runs/36532307229
- Template version: `9c6ea54a474042575381725895d822113ef26c7c` (synced 2026-08-11)

`.github/` is template-owned so the workflow is fixed upstream. `.nvmrc` is **not**
template-owned — raising it to `24` (which ships npm 11) would unblock this
repository without waiting, if the fleet wants that.

**Until it is green, a merge is not evidence that anything works.** Every claim in
this file was verified by hand.

---

## Already done

- **Billing terms** — `/terms` covers price, cancellation, access after
  cancellation, refunds and support. Support is admin@draftlabs.org, two business
  days. Single source of truth in `src/lib/billing-copy.ts`; the price is derived
  from `PLAN_PRICES.pro`, so it cannot go stale inside a binding promise.
- **Self-serve cancellation** — dashboard → "Manage billing or cancel" → Stripe
  billing portal. No email, no retention gate. Access continues to the end of the
  paid month, matching the published terms.
- **Revenue and attribution on the row** — `public.subscriptions` stores
  `price_cents` (integer cents, `6000` = $60.00), `currency`, `billing_interval`,
  `current_period_end`, `gclid` and `utm_campaign`, so a sale is traceable to the
  click that bought it.
- **Open redirect closed** — `?next=` on `/login` and `/auth/callback` is validated
  by `safeInternalPath()` (PR #41).
