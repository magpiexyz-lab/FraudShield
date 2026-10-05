# FraudShield — go-live checklist

Everything that must be true before the first real customer is charged $60.

This file is the checklist because `.runs/deploy-manifest.json` cannot be: `.runs/`
is gitignored, so the manifest exists only on the machine that ran `/deploy` and
nobody else can read it. This is committed, diffable, and reviewable in a PR.

**Order matters.** Line 1 is last on launch day; lines 2–6 gate whether launch
day happens at all. Lines 3 and 4 are done; 2 and 5 are not.

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

## 3. Duplicate-subscription guard shipped

**Status:** DONE. [PR #51](https://github.com/magpiexyz-lab/FraudShield/pull/51)
merged 2026-09-29 and verified on production: an account with an active
subscription now sees "You're on Pro" on /pricing instead of "Choose Pro", and
/api/checkout refuses a second purchase with 409.

The pricing card showed "Choose Pro" to a customer who was already paying, and
the checkout it opened worked — so they bought a second subscription and Stripe
billed them **$120/month**. The webhook upserts on `user_id`, so our row pointed
at whichever session completed last while the first one kept billing invisibly,
and cancelling in the portal ended only whichever the customer happened to pick.

It is on this list because the cost changes at go-live: today it is test money,
afterwards it is a real customer charged twice, a refund and an apology.

`/api/checkout` now refuses with `409 already_subscribed` before any Stripe
session is created, and both upgrade surfaces show "You're on Pro" with a link to
the billing portal. The server guard is the binding one — the UI can be walked
around by a stale tab, a back button or a direct POST.

---

## 4. Conversion matching when the click id is lost

**Status:** DONE. [PR #52](https://github.com/magpiexyz-lab/FraudShield/pull/52)
merged 2026-09-30, migration 011 applied by hand, verified on production.

`gclid` is the precise link from a sale to the ad that bought it, and the
fragile one: ad blockers, stripped query strings and purchases made days later
in another browser all arrive without it. Those sales are real revenue the Ads
upload cannot attribute, so the campaign measures worse than it performed.

`public.subscriptions.email_sha256` now carries the hex SHA-256 of the trimmed,
lower-cased account email as a fallback join key. Computed in the checkout route
from the AUTHENTICATED session email -- never from `session.customer_email`,
which is attacker-controllable and would let a buyer have their purchase
credited to someone else's ad click.

**Verified on the first live test**, and on exactly the case it exists for: the
new row came back with `gclid` NULL and a valid 64-character digest. Under the
old schema that sale would have been unattributable.

Backfill is not possible and not attempted -- the hash is taken at checkout, so
rows that predate the column stay NULL. `where email_sha256 is null` finds them.

---

## 5. Renewal events proven

**Status:** DONE. All five verified end to end against the live test-mode endpoint.

| Event | Verified |
|---|---|
| `checkout_started` | yes |
| `subscription_activated` | yes |
| `subscription_canceled` | yes — 2026-09-29 |
| `invoice_paid` | yes — 2026-10-05, Stripe test clock |
| `payment_failed` | yes — 2026-10-05, Stripe test clock |

The last two never fire on a first purchase, by design:

```ts
const isRenewal = invoice.billing_reason !== "subscription_create";
if (subscriptionId && isRenewal) { ... }
```

Without that gate every new sale would be counted twice, once as a sale and once as
a renewal. Proving them therefore requires a forced renewal via a Stripe test clock.

PostHog event ids, as requested:

- `invoice_paid`: `01a10ba3-69e6-7074-ba85-511eeb786de7`
- `payment_failed`: `01a10ba7-4829-7015-ba77-9740605d7d33`

HOW THEY WERE PRODUCED. A test clock, a customer created on it, a $60 USD
subscription, then the clock advanced a month to force a renewal. The
subscriptions row was repointed at the simulated subscription for the duration,
because the webhook resolves the user by stripe_subscription_id and would
otherwise have matched nothing.

TWO THINGS WORTH KNOWING, found doing it:

One failing customer produces SIX TO EIGHT payment_failed events, not one.
Stripe retries a failed invoice on its dunning schedule and sends
invoice.payment_failed for every attempt; the handler reports each. Every one is
a real failed attempt, so this is not wrong -- but anything counting these as
"customers who failed to pay" will overstate it several times over. Worth
deciding before the number is used.

Repointing the row let the failures write past_due onto the REAL account's row,
which computeQuota gates on, so that account silently lost its Pro quota until
it was set back. Anyone repeating this should restore both
stripe_subscription_id and status afterwards, not just the id.

---

## 6. CI is not currently a safety net

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
