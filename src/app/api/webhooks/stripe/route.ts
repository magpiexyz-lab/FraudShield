// POST /api/webhooks/stripe — Stripe webhook handler (b-07 system actor).
//
// Verifies the raw request body via STRIPE_WEBHOOK_SECRET, then handles
// `checkout.session.completed` by upserting the user's subscription to
// status='active' + their paid plan. Idempotent via the stripe_events table
// (INSERT + catch PG 23505 — atomic at the DB level).
//
// NO rate limiting — Stripe retries delivery on failure; a rate limiter
// would silently drop legitimate retries. The signature verify is the
// cryptographic boundary.

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { createServiceRoleClient } from "@/lib/supabase-server";
import { trackServerEvent } from "@/lib/analytics-server";
import { nullableAttributionValue } from "@/lib/attribution";
import { isPendingCancellation } from "@/lib/stripe-cancel";
import { PLAN_PRICES, PRO_SCAN_QUOTA } from "@/lib/types";

// Paid subscriptions raise scan quota above the free allowance. Sourced from
// PRO_SCAN_QUOTA rather than restated: this held 9999 ("effectively unlimited")
// after the plan moved to a 200/month cap, so an actual subscriber would have
// been granted 50x what the pricing page sells them.
const PLAN_SCAN_QUOTA: Record<string, number> = {
  pro: PRO_SCAN_QUOTA,
};

// The END of the current billing period, read off the Stripe Subscription.
//
// PAYLOAD SHAPE, verified against the pinned SDK rather than assumed: in
// stripe 22.2.0 Subscription has NO top-level current_period_end. The period
// moved down onto the subscription ITEMS -- see current_period_end on
// SubscriptionItem in node_modules/stripe/cjs/resources/SubscriptionItems.d.ts,
// which is Unix SECONDS. Reading subscription.current_period_end would not
// compile. Same class of trap as Invoice.subscription in the invoice handler
// below, and checked the same way: by reading the shipped .d.ts.
//
// items.data[0] IS the subscription period here. The checkout route opens every
// session with a single Price at quantity 1, so there is exactly one item.
//
// NEVER THROWS. A missing end date must not block activating a subscription the
// customer has already been charged for, so every failure path logs and returns
// null. current_period_end is nullable (009) precisely so this can happen.
async function fetchCurrentPeriodEnd(
  subscriptionId: string,
): Promise<string | null> {
  try {
    const subscription =
      await getStripe().subscriptions.retrieve(subscriptionId);
    const periodEndSeconds = subscription.items.data[0]?.current_period_end;
    if (typeof periodEndSeconds !== "number") {
      console.warn(
        "[webhook] subscription reported no current_period_end:",
        subscriptionId,
      );
      return null;
    }
    return new Date(periodEndSeconds * 1000).toISOString();
  } catch (err) {
    console.error(
      "[webhook] could not retrieve subscription for current_period_end:",
      subscriptionId,
      err,
    );
    return null;
  }
}

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET is not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("[webhook] signature verification failed:", err);
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Idempotency guard — INSERT + catch PG 23505. Atomic per the PRIMARY KEY
  // on stripe_event_id. Two concurrent deliveries: exactly one INSERT
  // succeeds; the other gets 23505 and we return 200 to suppress retries.
  const supabase = createServiceRoleClient();
  const { error: insertErr } = await supabase
    .from("stripe_events")
    .insert({ stripe_event_id: event.id });
  if (insertErr) {
    if ((insertErr as { code?: string }).code === "23505") {
      return NextResponse.json({ received: true });
    }
    console.error("[webhook] stripe_events insert error:", insertErr);
    return NextResponse.json(
      { error: "Persistence error" },
      { status: 500 },
    );
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const userId = session.metadata?.user_id ?? "";
    const plan = session.metadata?.plan ?? "";
    const amountCents = Number(session.metadata?.amount_cents ?? 0);

    // NEVER resolve user identity via session.customer_email — that field is
    // attacker-controllable. The user_id metadata was set server-side at
    // checkout creation by an authenticated route, so it is trustworthy.
    if (!userId) {
      console.error("[webhook] missing user_id in session metadata", session.id);
      return NextResponse.json({ received: true });
    }

    const planQuota =
      typeof PLAN_SCAN_QUOTA[plan] === "number" ? PLAN_SCAN_QUOTA[plan] : 100;
    const planAmount =
      amountCents > 0
        ? amountCents
        : (typeof PLAN_PRICES[plan] === "number" ? PLAN_PRICES[plan] : 0);

    // The Stripe subscription this checkout created, resolved once: it is both
    // the value stored on the row and the handle used to fetch the period end.
    const subscriptionId =
      typeof session.subscription === "string" ? session.subscription : null;

    // How often this bills. Read from the metadata bag that
    // src/app/api/checkout/route.ts stamps onto BOTH the Session and the
    // Subscription, where it was written from the Stripe Price that route had
    // already retrieved AND validated. Taking it from there keeps the value
    // server-validated and costs no second round-trip to Stripe.
    //
    // nullableAttributionValue is reused for the blank-to-NULL step -- not
    // because this is attribution, but because it is the same boundary. Stripe
    // metadata cannot hold null, so an absent value arrives as the empty
    // string, and storing that would hide it from `where billing_interval is
    // null`. One representation of absent per column.
    const billingInterval = nullableAttributionValue(
      session.metadata?.billing_interval,
    );

    // When the current period ends. NOT carried on the Session, so it has to be
    // fetched from the Subscription. Null on any failure, never a throw.
    const currentPeriodEnd = subscriptionId
      ? await fetchCurrentPeriodEnd(subscriptionId)
      : null;

    const { error: upsertErr } = await supabase.from("subscriptions").upsert(
      {
        user_id: userId,
        status: "active",
        plan,
        scan_quota: planQuota,
        // Billing anchor for the monthly scan quota. Checkout completing IS the
        // start of the first period; the scan route rolls this forward in whole
        // months, so quota resets correctly without depending on a renewal
        // webhook having fired. See 007_subscription_period.sql.
        current_period_start: new Date().toISOString(),
        // What this subscription cost and which ad bought it. All four values
        // were already in hand here and were previously discarded, leaving the
        // price unreadable from the database side and the sale untraceable back
        // to its click. See 008_subscription_price_attribution.sql.
        //
        // planAmount is reused, not recomputed: it is the same figure reported
        // to analytics below, so the row and the event cannot disagree about
        // revenue. Integer cents, matching pay_intent.price_cents.
        price_cents: planAmount,
        // Read from the session rather than hardcoded. Stripe reports the
        // lowercase ISO-4217 code it actually charged in; hardcoding "usd"
        // would keep saying "usd" even if it ever charged something else. The
        // fallback only fires if Stripe omits the field, and the checkout route
        // refuses any Price that is not usd, so usd is the only possibility.
        currency: session.currency ?? "usd",
        // The checkout route writes "" for attribution it does not have
        // (Stripe metadata cannot hold null), so normalise back to NULL —
        // otherwise "no attribution" is invisible to `where gclid is null`.
        gclid: nullableAttributionValue(session.metadata?.gclid),
        utm_campaign: nullableAttributionValue(session.metadata?.utm_campaign),
        // Fallback join key for the Ads upload when gclid is absent. Already a
        // hash when it arrives: computed in the checkout route from the
        // AUTHENTICATED user's email, deliberately not from
        // session.customer_email, which is attacker-controllable and would let
        // a buyer choose whose conversion their sale is credited to.
        //
        // Same "" -> NULL normalisation as the two attribution values above:
        // Stripe metadata cannot hold null, and the digest of the empty string
        // is a real constant that would join every unmatched row to every
        // other. See 011_subscription_email_match.sql.
        email_sha256: nullableAttributionValue(session.metadata?.email_sha256),
        // How often Stripe bills this, and when the current period ends. Both
        // were unanswerable from the row before 009: the cadence lived only on
        // the dashboard Price and the end date only on the Subscription.
        //
        // billing_interval is DESCRIPTIVE, not a constraint. The binding
        // monthly/usd/amount check is the Price validation in
        // src/app/api/checkout/route.ts, which refuses to open a session at all
        // when the Price disagrees with PLAN_PRICES. This column records what
        // that guard let through.
        billing_interval: billingInterval,
        // Partner of current_period_start above, so the two describe the same
        // period rather than drifting apart. NULL when Stripe could not be
        // reached or reported no end date -- deliberately not fatal, because the
        // customer has already been charged.
        current_period_end: currentPeriodEnd,
        // A returning customer reuses this row (onConflict user_id), so the
        // pending-cancellation state from their PREVIOUS subscription has to be
        // cleared here. Leaving it set would make a brand-new paid subscription
        // read as already-cancelled, and would silently suppress the
        // exactly-once guard the next time they really do cancel.
        cancel_at_period_end: false,
        canceled_at: null,
        stripe_customer_id:
          typeof session.customer === "string" ? session.customer : null,
        // Which Stripe mode produced this row. Taken from the EVENT rather
        // than fetched, so it costs nothing and is available on every handler.
        // The Ads uploader will not send a conversion without it, and must
        // never send a test-mode purchase as revenue. See 012.
        livemode: event.livemode,
        stripe_subscription_id: subscriptionId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (upsertErr) {
      console.error("[webhook] subscriptions upsert error:", upsertErr);
      return NextResponse.json(
        { error: "Persistence error" },
        { status: 500 },
      );
    }

    await trackServerEvent("subscription_activated", userId, {
      plan,
      amount_cents: planAmount,
      amount: planAmount,
      provider: "stripe",
    });
  }

  // Cancellation ELAPSED. Fires when a subscription actually ends - either
  // because it was cancelled immediately, or because a cancel-at-period-end
  // request finally ran out of paid month. This is the only place access ends,
  // and the only place status becomes canceled.
  //
  // Identity comes from stripe_subscription_id, NOT metadata: this event carries
  // a Subscription object, which has no session metadata. That column is unique
  // (001_initial.sql), and it is populated from session.subscription at checkout
  // - a string only in subscription mode, which is why cancellation could not
  // have been wired while the plan was a one-off payment.
  //
  // computeQuota gates on status === "active", so flipping the status is all
  // that is needed to drop the user back to the free allowance. No quota write,
  // no second source of truth.
  if (event.type === "customer.subscription.deleted") {
    const subscription = event.data.object as Stripe.Subscription;

    const { error: cancelErr } = await supabase
      .from("subscriptions")
      .update({
        status: "canceled",
        livemode: event.livemode,
        updated_at: new Date().toISOString(),
      })
      .eq("stripe_subscription_id", subscription.id);

    if (cancelErr) {
      console.error("[webhook] subscription cancel update error:", cancelErr);
      return NextResponse.json(
        { error: "Persistence error" },
        { status: 500 },
      );
    }

    // Resolve the owner for analytics. The Subscription object carries no
    // session metadata, so the row we just updated is the identity source.
    // cancel_at_period_end comes back with it because it decides whether this
    // cancellation has ALREADY been reported; the update above does not touch
    // that column, so reading it here still sees the pre-existing value.
    const { data: canceledRow } = await supabase
      .from("subscriptions")
      .select("user_id, plan, cancel_at_period_end")
      .eq("stripe_subscription_id", subscription.id)
      .maybeSingle();
    const canceled = canceledRow as {
      user_id?: string;
      plan?: string;
      cancel_at_period_end?: boolean;
    } | null;

    // DOUBLE-FIRE GUARD. A Billing Portal cancellation is reported the moment
    // the customer asks for it, on customer.subscription.updated below, and
    // only elapses into THIS event up to 30 days later. Reporting again here
    // would mean two subscription_canceled events for one cancellation, which
    // would overstate churn by exactly the number of customers whose month ran
    // out. The pending flag that handler recorded (010) is what suppresses it.
    //
    // An IMMEDIATE cancellation never passes through the pending state, so the
    // flag is false and this handler stays the one and only report for it.
    const alreadyReported = canceled?.cancel_at_period_end === true;

    if (canceled?.user_id && !alreadyReported) {
      await trackServerEvent("subscription_canceled", canceled.user_id, {
        plan: canceled.plan ?? "",
        provider: "stripe",
      });
    }
  }

  // Cancellation REQUESTED. This is the event a Billing Portal cancellation
  // actually produces, and handling it is the whole point of this branch: a
  // real cancellation on the live site emitted TWO customer.subscription.updated
  // events and NO customer.subscription.deleted, so nothing was reported and
  // nothing was recorded. Cancelling in the portal sets cancel_at_period_end and
  // leaves the subscription ACTIVE; .deleted does not arrive until the paid
  // period actually elapses, up to 30 days later.
  //
  // customer.subscription.updated also fires for plenty of things that are not
  // cancellations - price changes, card updates, quantity changes - so every
  // decision below is driven by a STATE TRANSITION, never by the arrival of the
  // event.
  if (event.type === "customer.subscription.updated") {
    const subscription = event.data.object as Stripe.Subscription;

    // PAYLOAD SHAPE. This used to read subscription.cancel_at_period_end and
    // nothing else, checked against the SDK's .d.ts - which type-checks and is
    // still WRONG, because the Billing Portal no longer sets that field. It
    // schedules cancel_at at the period end and leaves cancel_at_period_end
    // false, so the handler saw no transition and reported nothing. Reading the
    // shipped types cannot catch a field the API has stopped populating; only a
    // real payload can. See isPendingCancellation for the captured event, and
    // tests/subscription-cancel-pending.test.ts, which now replays it.
    const pendingCancel = isPendingCancellation(subscription);

    const { data: subscriberRow } = await supabase
      .from("subscriptions")
      .select("user_id, plan, cancel_at_period_end")
      .eq("stripe_subscription_id", subscription.id)
      .maybeSingle();
    const subscriber = subscriberRow as {
      user_id?: string;
      plan?: string;
      cancel_at_period_end?: boolean;
    } | null;

    // Not a subscription this app owns. Acknowledge so Stripe stops retrying.
    if (!subscriber?.user_id) {
      return NextResponse.json({ received: true });
    }

    // IDEMPOTENCY, derived from row state and not from the event. Stripe sent
    // two customer.subscription.updated deliveries seconds apart for the single
    // real cancellation. The stripe_events insert at the top of this file cannot
    // help: it dedupes by Stripe event id, and those two deliveries had
    // DIFFERENT ids, so both pass it cleanly. What does not differ is the row -
    // once the pending cancellation is recorded, the second delivery sees it and
    // reports nothing.
    const alreadyPending = subscriber.cancel_at_period_end === true;

    if (pendingCancel && !alreadyPending) {
      // RECORD FIRST, REPORT SECOND, deliberately. If the order were reversed,
      // a failed write would return 500, Stripe would retry the SAME event id,
      // the stripe_events guard would swallow the retry - and the next
      // .updated delivery would find the row still unmarked and fire a SECOND
      // subscription_canceled. Writing first makes the failure mode a missing
      // report that the next delivery repairs, instead of a duplicate one.
      //
      // NOTE WHAT IS NOT WRITTEN HERE: the status column. The customer has paid
      // for the current period and the published terms promise access to the
      // end of it, so access must continue; computeQuota gates on status, which
      // makes leaving it alone the entire access-preservation mechanism. Only
      // the PENDING state is recorded. See 010_subscription_cancel_pending.sql.
      const { error: pendingErr } = await supabase
        .from("subscriptions")
        .update({
          cancel_at_period_end: true,
          livemode: event.livemode,
          // When the customer asked, as Stripe reports it - Unix SECONDS and
          // nullable, like every other Stripe timestamp. Falling back to now
          // keeps the decision dated even if Stripe omits it; a NULL here would
          // mean no cancellation was ever requested, which is not true.
          canceled_at:
            typeof subscription.canceled_at === "number"
              ? new Date(subscription.canceled_at * 1000).toISOString()
              : new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);

      if (pendingErr) {
        console.error(
          "[webhook] pending cancellation update error:",
          pendingErr,
        );
        return NextResponse.json(
          { error: "Persistence error" },
          { status: 500 },
        );
      }

      // Same event name and same property shape as the elapsed-cancellation
      // path above, on purpose: churn queries must not have to know which of
      // the two webhooks reported a cancellation.
      await trackServerEvent("subscription_canceled", subscriber.user_id, {
        plan: subscriber.plan ?? "",
        provider: "stripe",
      });
    } else if (alreadyPending && !pendingCancel) {
      // UN-CANCEL. The customer reversed the pending cancellation in the
      // portal, which clears the scheduled cancel_at (and cancel_at_period_end
      // where that is what was set) and emits another .updated. Clearing our
      // own flag restores the row to plain-active AND re-arms the guard above,
      // so a later genuine cancellation is reported again.
      //
      // The column keeps its name because it is OUR record of "a cancellation
      // has been reported", not a mirror of any one Stripe field - which is
      // what lets the .deleted handler's double-fire guard read it safely.
      //
      // canceled_at is deliberately left in place. The boolean is what carries
      // pending, so retaining the timestamp costs no correctness and preserves
      // the only record that this subscriber was at risk and was saved. It is
      // overwritten if they ask to cancel again.
      //
      // NO ANALYTICS EVENT. experiment/EVENTS.yaml declares no reactivation
      // event, and reporting subscription_activated instead would double-count
      // a sale that checkout.session.completed already reported. Silence is the
      // correct output here.
      const { error: resumeErr } = await supabase
        .from("subscriptions")
        .update({
          cancel_at_period_end: false,
          livemode: event.livemode,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subscription.id);

      if (resumeErr) {
        console.error("[webhook] un-cancel update error:", resumeErr);
        return NextResponse.json(
          { error: "Persistence error" },
          { status: 500 },
        );
      }
    }
    // No third branch: when the flag matches what we already stored, this
    // delivery carried no cancellation transition at all - a price change, a
    // card update, or simply the duplicate delivery Stripe sent. Nothing to
    // record and nothing to report.
  }

  // Renewal. invoice.paid also fires for the FIRST invoice of a new
  // subscription, which checkout.session.completed already reported - counting
  // both would double-count every new sale as a renewal too. billing_reason
  // separates them.
  //
  // NOTE on the payload shape: Stripe SDK 22.2.0 Invoice has NO top-level
  // `subscription` field. The id and metadata live under
  // invoice.parent.subscription_details, so reading invoice.subscription here
  // would not compile.
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoice = event.data.object as Stripe.Invoice;
    const parent = invoice.parent as {
      subscription_details?: { subscription?: string | { id?: string } };
    } | null;
    const rawSub = parent?.subscription_details?.subscription;
    const subscriptionId =
      typeof rawSub === "string" ? rawSub : rawSub?.id ?? null;

    const isRenewal = invoice.billing_reason !== "subscription_create";

    if (subscriptionId && isRenewal) {
      const { data: ownerRow } = await supabase
        .from("subscriptions")
        .select("user_id, plan")
        .eq("stripe_subscription_id", subscriptionId)
        .maybeSingle();
      const owner = ownerRow as { user_id?: string; plan?: string } | null;

      if (owner?.user_id) {
        if (event.type === "invoice.paid") {
          // Renewal succeeded: keep the plan active and roll the quota window
          // forward so the subscriber gets their next 200 scans.
          //
          // The period END has to move with the start. current_period_start is
          // rolled forward just below; leaving its partner at the value written
          // back at checkout would leave the row describing a period that ended
          // before it started, and the gap would widen every month.
          //
          // billing_interval is deliberately NOT rewritten here. The cadence
          // does not change when an existing subscription renews, so rewriting
          // it would only add a way for it to become wrong.
          const renewedPeriodEnd = await fetchCurrentPeriodEnd(subscriptionId);
          const { error: renewErr } = await supabase
            .from("subscriptions")
            .update({
              status: "active",
              current_period_start: new Date().toISOString(),
              current_period_end: renewedPeriodEnd,
              // Repeated on renewal so a row that somehow missed it at
              // checkout is repaired rather than staying NULL and silently
              // dropping out of the upload. A subscription's mode never
              // changes, so rewriting it cannot make the row wrong.
              livemode: event.livemode,
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subscriptionId);
          if (renewErr) {
            console.error("[webhook] renewal update error:", renewErr);
            return NextResponse.json(
              { error: "Persistence error" },
              { status: 500 },
            );
          }
          await trackServerEvent("invoice_paid", owner.user_id, {
            amount: invoice.amount_paid ?? 0,
            billing_reason: invoice.billing_reason ?? "",
            provider: "stripe",
          });
        } else {
          // Dunning. Stripe retries on its own schedule; past_due drops the
          // user to the free allowance via computeQuota until it clears.
          const { error: failErr } = await supabase
            .from("subscriptions")
            .update({
              status: "past_due",
              updated_at: new Date().toISOString(),
            })
            .eq("stripe_subscription_id", subscriptionId);
          if (failErr) {
            console.error("[webhook] payment failed update error:", failErr);
            return NextResponse.json(
              { error: "Persistence error" },
              { status: 500 },
            );
          }
          await trackServerEvent("payment_failed", owner.user_id, {
            amount: invoice.amount_due ?? 0,
            provider: "stripe",
          });
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
