"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Sparkles, FileSearch } from "lucide-react";
import { createClient } from "@/lib/supabase";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FREE_SCAN_QUOTA, type SubscriptionsRow } from "@/lib/types";
import { computeQuota, scanWindowStart } from "@/lib/quota";
import { UploadZone } from "./upload-zone";
import { AbandonFollowup } from "./abandon-followup";
import { ScanHistory } from "./scan-history";
import { WhatWeCheck } from "./what-we-check";
import { ManageBilling } from "./manage-billing";
import { HowItWorks } from "./how-it-works";
import { AI_PRIVACY_DISCLOSURE } from "@/lib/fraud/analysis-mode";
import { trackPaywallShown } from "@/lib/events";

type QuotaState = {
  used: number;
  total: number;
  remaining: number;
  /**
   * True only for a genuine active subscription. NOT derived from a raised
   * total: once purchased credits count toward the total, a scan-pack buyer's
   * total exceeds the free allowance, and gating the billing portal on that
   * would offer "Manage billing" to someone with no subscription to manage.
   */
  isPaid: boolean;
  /** True when part of this allowance was bought outright (a scan pack). */
  purchased: boolean;
  loading: boolean;
};

export default function DashboardPage() {
  const [quota, setQuota] = useState<QuotaState>({
    used: 0,
    total: FREE_SCAN_QUOTA,
    remaining: FREE_SCAN_QUOTA,
    isPaid: false,
    purchased: false,
    loading: true,
  });
  // Bumped when a scan batch finishes. This page reads its quota from the
  // client, so router.refresh() cannot re-run the fetch below on its own —
  // the counter is what re-runs it.
  const [quotaEpoch, setQuotaEpoch] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();

      // Read the billing row FIRST, because it carries the anchor that decides
      // which scans count toward the allowance.
      //
      // NO STATUS FILTER, and scan_credits is selected. This read used to
      // filter to `status = "active"` and never asked for credits, which hid a
      // scan-pack buyer's row completely: their status is "inactive" because
      // they bought scans, they did not subscribe. The total then fell back to
      // the free allowance, remaining computed to 0, and the dashboard locked
      // them out of scans they had already paid for while the exhausted paywall
      // kept offering to sell them more. The row is per-user BILLING STATE, not
      // proof of a plan — /api/scan reads it exactly this way.
      //
      // No user_id filter: RLS policy `subscriptions_select_own` already scopes
      // this to the caller.
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("status, scan_quota, scan_credits, current_period_start")
        .maybeSingle();

      const subscription = sub as Pick<
        SubscriptionsRow,
        "status" | "scan_quota" | "scan_credits" | "current_period_start"
      > | null;

      let scanQuery = supabase
        .from("scans")
        // Must match the server-side quota check in /api/scan — partial image
        // analyses do not consume a free scan, so the meter must not show them
        // as spent.
        .select("id", { count: "exact", head: true })
        .eq("counts_toward_quota", true);

      // A subscriber's allowance is monthly, so only this window's scans count;
      // this page used to count all-time for everyone, which over-counted their
      // usage. Null means all-time counting is correct (free tier, a pack
      // buyer, or a comped lifetime grant).
      const windowStart = scanWindowStart(subscription, new Date());
      if (windowStart) {
        scanQuery = scanQuery.gte("created_at", windowStart.toISOString());
      }

      const { count } = await scanQuery;

      if (!active) return;

      // Same decision the scan endpoint enforces, from the same module.
      const result = computeQuota({
        scans_used: count ?? 0,
        subscription,
      });

      setQuota({
        used: count ?? 0,
        total: result.total_quota,
        remaining: result.remaining,
        isPaid: result.is_paid,
        purchased: !result.is_paid && (subscription?.scan_credits ?? 0) > 0,
        loading: false,
      });
    })();
    return () => {
      active = false;
    };
  }, [quotaEpoch]);

  const remaining = quota.remaining;

  // Fires when the exhausted card actually renders — once, not per render.
  // Gated on `!quota.loading` so the first paint (used=0, total=default) cannot
  // report a paywall the user never saw.
  const dashboardPaywallFired = useRef(false);
  useEffect(() => {
    if (quota.loading || remaining > 0 || dashboardPaywallFired.current) return;
    dashboardPaywallFired.current = true;
    trackPaywallShown({ surface: "dashboard_quota" });
  }, [quota.loading, remaining]);
  const isPaid = quota.isPaid;
  const pct = quota.total > 0 ? Math.min((quota.used / quota.total) * 100, 100) : 0;
  // Someone who bought a scan pack spent scans they paid for, not free ones.
  const exhaustedHeadline = quota.purchased
    ? `You've used all ${quota.total} of your scans.`
    : `Your free ${quota.total === 1 ? "scan has" : "scans have"} been used.`;

  return (
    <div className="dark min-h-screen overflow-x-hidden bg-background text-foreground">
      {/* Ambient signal-cyan mesh + noise depth for the evidence-lab surface */}
      <div className="relative">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
          style={{
            background:
              "radial-gradient(60% 80% at 85% 0%, rgba(47,182,201,0.12), transparent 70%)",
          }}
        />

        <div className="relative mx-auto max-w-5xl px-5 py-10 sm:px-8 sm:py-14">
          {/* Header */}
          <header className="mb-7">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="flex items-center gap-2 font-[family-name:var(--font-mono)] text-xs uppercase tracking-[0.2em] text-signal">
                  <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Evidence Lab
                </p>
                <h1 className="mt-2 font-[family-name:var(--font-heading)] text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                  Scan a document
                </h1>
                <p className="mt-2 max-w-xl text-base text-muted-foreground">
                  Upload a pay stub, bank statement, or invoice. FraudShield runs
                  metadata forensics, AI content review, and template matching to
                  return a fraud score in seconds.
                </p>
              </div>

              <QuotaMeter
                loading={quota.loading}
                used={quota.used}
                total={quota.total}
                remaining={remaining}
                isPaid={isPaid}
                purchased={quota.purchased}
                pct={pct}
              />
              {/* Paid subscribers must be able to cancel from inside the product:
                  Stripe checkout promises "until you cancel" and the ads say
                  "Cancel anytime". */}
              {isPaid ? <ManageBilling /> : null}
            </div>
          </header>

          {/* Asked only of someone whose Stripe Checkout Session expired —
              they closed the tab rather than pressing back, so the pricing
              prompt never got the chance. Above the upload zone because it is
              about something that already happened; below the header so it
              never displaces the primary task. Renders nothing for everyone
              else. */}
          <AbandonFollowup />

          {/* Primary task: upload + scan */}
          <section aria-labelledby="upload-heading" className="mb-8">
            <h2 id="upload-heading" className="sr-only">
              Upload a document for analysis
            </h2>
            {/* Two columns on wide screens: the drop zone was centred in a
                container far wider than itself, leaving dead space either side
                of the primary action. */}
            <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <UploadZone
                quotaRemaining={quota.loading ? FREE_SCAN_QUOTA : remaining}
                onScansCompleted={() => setQuotaEpoch((n) => n + 1)}
              />
              <WhatWeCheck />
            </div>

            {/* Full width, below both columns. Inside the upload column this
                made that side far taller than the panel and left a large empty
                rectangle under it. */}
            <HowItWorks className="mt-4" />

            {/* Moved out of the upload column so the two cards above can end on
                the same line. It still sits above the fold on the page a user
                reads before committing a document. */}
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              {AI_PRIVACY_DISCLOSURE}
            </p>
          </section>

          {/* Scan history */}
          <section aria-labelledby="history-heading">
            <div className="mb-4 flex items-center justify-between">
              <h2
                id="history-heading"
                className="flex items-center gap-2 font-[family-name:var(--font-heading)] text-xl font-semibold text-foreground"
              >
                <FileSearch className="h-5 w-5 text-signal" aria-hidden="true" />
                Recent scans
              </h2>
            </div>
            <ScanHistory />
          </section>

          {/* Contextual forward CTA — dashboard is a behavior-only destination
              (golden_path terminates at scan-result). Most-advancing action when
              the free allowance is spent is to unlock more scans. Uses signal
              tokens (forward-motion brand accent), NOT severity tokens —
              "out of quota" is a billing/system state, not a fraud signal. */}
          {!quota.loading && remaining <= 0 && (
            <div className="mt-10 flex flex-col items-center gap-3 rounded-[var(--radius-lg)] bg-card p-6 text-center ring-1 ring-signal/30">
              <Sparkles className="h-5 w-5 text-signal" aria-hidden="true" />
              <p className="text-base font-medium text-foreground">
                {exhaustedHeadline}
              </p>
              <p className="max-w-md text-sm text-muted-foreground">
                Upgrade to keep verifying documents and unlock additional scan quota.
              </p>
              <Link
                href="/pricing"
                className={cn(
                  buttonVariants(),
                  "h-11 rounded-[var(--radius-pill)] bg-signal text-signal-foreground hover:bg-signal/90 hover:shadow-[var(--shadow-signal-glow)]",
                )}
              >
                View plans
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function QuotaMeter({
  loading,
  used,
  total,
  remaining,
  isPaid,
  purchased,
  pct,
}: {
  loading: boolean;
  used: number;
  total: number;
  remaining: number;
  isPaid: boolean;
  purchased: boolean;
  pct: number;
}) {
  return (
    <div className="min-w-[200px] rounded-[var(--radius-lg)] bg-card p-4 ring-1 ring-border">
      <div className="flex items-baseline justify-between">
        <span className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted-foreground">
          {/* "Free scans" is only true of an allowance that was given away.
              A pack buyer paid for most of theirs, so the meter must not
              label their purchase free -- the same claim the exhausted card
              used to make. */}
          {isPaid || purchased ? "Scans" : "Free scans"}
        </span>
        {loading ? (
          <span className="h-5 w-16 animate-pulse rounded-full bg-muted" aria-hidden="true" />
        ) : (
          <span className="font-[family-name:var(--font-mono)] text-sm tabular-nums text-foreground">
            {/* Severity tokens (suspect/fraud) are reserved for scan-result
                fraud-score state. Quota states use signal (active) and
                slate-steel (depleted) — never amber/vermilion. */}
            <span
              className={cn(
                "text-lg font-semibold",
                remaining <= 0 ? "text-slate-steel" : "text-signal",
              )}
            >
              {remaining}
            </span>
            <span className="text-muted-foreground"> / {total} left</span>
          </span>
        )}
      </div>
      {/* Usage bar — fills with signal-cyan as scans are consumed.
          At 100% (depleted) it stays signal-cyan; the depletion semantics
          live in the muted count above, not in a fraud-vocabulary color swap. */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-signal transition-all duration-500"
          style={{ width: loading ? "0%" : `${pct}%` }}
        />
      </div>
      <p className="mt-2 font-[family-name:var(--font-mono)] text-[11px] text-muted-foreground">
        {loading ? "Checking quota…" : `${used} used`}
      </p>
    </div>
  );
}
