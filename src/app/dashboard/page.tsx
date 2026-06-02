"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Sparkles, FileSearch } from "lucide-react";
import { createClient } from "@/lib/supabase";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FREE_SCAN_QUOTA, type SubscriptionsRow } from "@/lib/types";
import { UploadZone } from "./upload-zone";
import { ScanHistory } from "./scan-history";

type QuotaState = {
  used: number;
  total: number;
  loading: boolean;
};

export default function DashboardPage() {
  const [quota, setQuota] = useState<QuotaState>({
    used: 0,
    total: FREE_SCAN_QUOTA,
    loading: true,
  });

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();

      // Used = count of this user's scans (RLS scopes to the current user).
      const { count } = await supabase
        .from("scans")
        .select("id", { count: "exact", head: true });

      // Quota total: paid subscription raises it; otherwise the free allowance.
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("id, status, plan, scan_quota")
        .eq("status", "active")
        .maybeSingle();

      if (!active) return;

      const subscription = sub as Pick<
        SubscriptionsRow,
        "status" | "scan_quota"
      > | null;
      const total =
        subscription?.status === "active" && subscription.scan_quota
          ? subscription.scan_quota
          : FREE_SCAN_QUOTA;

      setQuota({ used: count ?? 0, total, loading: false });
    })();
    return () => {
      active = false;
    };
  }, []);

  const remaining = Math.max(quota.total - quota.used, 0);
  const isPaid = quota.total > FREE_SCAN_QUOTA;
  const pct = quota.total > 0 ? Math.min((quota.used / quota.total) * 100, 100) : 0;

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
          <header className="mb-10">
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
                  metadata forensics, cross-document checks, and template matching to
                  return a fraud score in seconds.
                </p>
              </div>

              <QuotaMeter
                loading={quota.loading}
                used={quota.used}
                total={quota.total}
                remaining={remaining}
                isPaid={isPaid}
                pct={pct}
              />
            </div>
          </header>

          {/* Primary task: upload + scan */}
          <section aria-labelledby="upload-heading" className="mb-12">
            <h2 id="upload-heading" className="sr-only">
              Upload a document for analysis
            </h2>
            <UploadZone quotaRemaining={quota.loading ? FREE_SCAN_QUOTA : remaining} />
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
                You&apos;ve used all {quota.total} free scans.
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
  pct,
}: {
  loading: boolean;
  used: number;
  total: number;
  remaining: number;
  isPaid: boolean;
  pct: number;
}) {
  return (
    <div className="min-w-[200px] rounded-[var(--radius-lg)] bg-card p-4 ring-1 ring-border">
      <div className="flex items-baseline justify-between">
        <span className="font-[family-name:var(--font-mono)] text-xs uppercase tracking-wider text-muted-foreground">
          {isPaid ? "Scans" : "Free scans"}
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
