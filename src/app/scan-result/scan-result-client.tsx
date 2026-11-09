"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { buttonVariants } from "@/components/ui/button";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { trackActivate, trackPaywallShown } from "@/lib/events";
import { Check, Lock, ShieldCheck } from "lucide-react";
import {
  analysisMode,
  isFullAnalysis,
  CHECKS_PERFORMED,
  LIMITED_ANALYSIS_TITLE,
  LIMITED_ANALYSIS_BODY,
  NO_INDICATORS_BODY,
  NO_INDICATORS_TITLE,
  VISION_ANALYSIS_BODY,
  VISION_CLEAR_BODY,
  type AnalysisMode,
} from "@/lib/fraud/analysis-mode";
import {
  FREE_SCAN_QUOTA,
  type FraudSignal,
  type ScansRow,
  type SubscriptionsRow,
} from "@/lib/types";
import { entitlementTier, type EntitlementTier } from "@/lib/pro-access";
import { topNamedReasons, type NamedReason } from "@/lib/top-signal";
import { computeQuota, scanWindowStart } from "@/lib/quota";
import { ScoreGauge } from "./score-gauge";
import { SignalBreakdown } from "./signal-breakdown";
import { ApiAccessDialog } from "./api-access-dialog";
import { CrossDocumentInterest } from "./cross-document-interest";
import { UpgradeCta } from "./upgrade-cta";
import { ScanPackOptions } from "@/components/scan-pack-options";
import {
  PACKS_DO_NOT_ADD_REASONS,
  PACKS_DO_NOT_UNLOCK,
  PACKS_HEADING_AFTER_LOCK,
  PACK_TOP_REASON_NOTE,
  SCORE_EVIDENCE_NOTE,
  SIGNAL_BREAKDOWN_NOTE,
  signalCountLabel,
  tierForCopy,
} from "@/lib/billing-copy";
import { severityLabel, severityOfScore, severityVar } from "./severity";
import { FeedbackWidget } from "@/components/feedback-widget";

const DOC_TYPE_LABEL: Record<string, string> = {
  pay_stub: "Pay stub",
  bank_statement: "Bank statement",
  invoice: "Invoice",
};

type LoadState = "loading" | "ready" | "missing";

/**
 * What this page needs to know about the user's allowance.
 *
 * It used to keep a raw all-time scan count and compare it against the free
 * allowance, which ignored scan_credits and scan_quota: a scan-pack buyer with
 * scans still in hand was told they had spent all their free ones and sold
 * another pack. The answer now comes from computeQuota -- the same authority
 * /api/scan enforces -- so this surface cannot disagree with the endpoint.
 */
type QuotaState = {
  /** True when the allowance is spent. Replaces the old count comparison. */
  exhausted: boolean;
  /** Scans left: free allowance plus purchased credits, or a plan's quota. */
  remaining: number;
  /** The whole allowance, for copy that names a number. */
  total: number;
  /**
   * True when any of this allowance was paid for — a scan pack or an active
   * plan. Copy only: the page must never call a paid scan a free one.
   */
  purchased: boolean;
};

/**
 * FAILS OPEN on purpose. Used before the read resolves and if it throws: an
 * unverified allowance must not raise a paywall, because the cost of a false
 * paywall is a user paying twice for scans they already own.
 */
const QUOTA_UNRESOLVED: QuotaState = {
  exhausted: false,
  remaining: FREE_SCAN_QUOTA,
  total: FREE_SCAN_QUOTA,
  purchased: false,
};

export function ScanResultClient() {
  const searchParams = useSearchParams();
  const scanId = searchParams.get("id");

  const [state, setState] = useState<LoadState>("loading");
  const [scan, setScan] = useState<ScansRow | null>(null);
  const [quota, setQuota] = useState<QuotaState>(QUOTA_UNRESOLVED);
  // FAILS CLOSED. Starts on "free" -- the one tier that reveals nothing -- and
  // is only ever moved by a row that has actually been read, so the window
  // before the subscription read resolves shows the fully locked view. Any
  // other default would flash a paid reason, or the whole breakdown, at every
  // free user on every page load.
  const [tier, setTier] = useState<EntitlementTier>("free");
  const activateFiredRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    async function load() {
      try {
        // Fetch the requested scan (or the most recent one for this user).
        let query = supabase
          .from("scans")
          .select("id, user_id, doc_type, fraud_score, signals, file_meta, created_at");
        query = scanId
          ? query.eq("id", scanId)
          : query.order("created_at", { ascending: false }).limit(1);

        const { data } = await query.maybeSingle();

        // WHO IS ALLOWED TO SEE THE BREAKDOWN, AND WHAT THEY HAVE LEFT. Read
        // here rather than passed down from a server component because this
        // page is a client component that already owns its own data fetching.
        //
        // Read BEFORE the scan count, because this row carries the anchor that
        // decides which scans count toward the allowance.
        //
        // No user_id filter and no service-role client: the RLS policy
        // subscriptions_select_own scopes this to the caller's own row, so one
        // user cannot read another plan. The gate below is entitlementTier,
        // which answers "pro" from hasProAccess and from nothing else -- so it
        // still matches computeQuota, the dashboard meter and the
        // already-subscribed guard in the checkout route, four surfaces that
        // have to agree about who is Pro, while adding the third tier b-13
        // needs. It is NOT status === "active": that is only the first of
        // the three branches, and an active row with no Stripe subscription is
        // a comp that expires at its period end. A pending cancellation is
        // deliberately still Pro -- they have paid for the current period --
        // and the predicate keeps it that way, because such a row carries a
        // stripe_subscription_id and is governed by status alone.
        //
        // scan_quota, scan_credits and current_period_start are now selected
        // too, because status cannot answer "may this user scan again?". A
        // scan-pack buyer's status is "inactive" -- they bought scans, they did
        // not subscribe -- so reading status alone made every pack buyer look
        // out of scans on the page they land on after every single scan.
        //
        // stripe_subscription_id and current_period_end are what expire a
        // COMPED grant: an active row with no Stripe subscription behind it is a
        // comp, and a comp ends at its period end. A missing
        // current_period_end reads as "no end date", i.e. perpetual, so a
        // shortened select here would unlock the paid breakdown for ever.
        const { data: sub } = await supabase
          .from("subscriptions")
          .select(
            "status, scan_quota, scan_credits, current_period_start, stripe_subscription_id, current_period_end",
          )
          .maybeSingle();

        const subscription = sub as Pick<
          SubscriptionsRow,
          | "status"
          | "scan_quota"
          | "scan_credits"
          | "current_period_start"
          | "stripe_subscription_id"
          | "current_period_end"
        > | null;

        // Matches the server-side quota check in /api/scan: a partial image
        // analysis returns evidence but no verdict, so it does not spend a
        // scan and must not trigger the quota prompt.
        let countQuery = supabase
          .from("scans")
          .select("id", { count: "exact", head: true })
          .eq("counts_toward_quota", true);

        // A subscriber's allowance is monthly, so only this window's scans
        // count. Null means all-time counting is correct (free tier, a pack
        // buyer, or a comped lifetime grant).
        // ONE CLOCK FOR THE WHOLE DECISION: the window picked here, the Pro
        // flag set below and the allowance all derive from hasProAccess, and
        // the awaited count query sits between them. Three separate clock
        // reads let a comp expiring in that gap be Pro for the window and
        // expired for the allowance in the same render -- a monthly window
        // against a free allowance. QuotaInput.now exists for this.
        const now = new Date();

        const windowStart = scanWindowStart(subscription, now);
        if (windowStart) {
          countQuery = countQuery.gte("created_at", windowStart.toISOString());
        }

        const { count } = await countQuery;

        if (cancelled) return;

        // ONE ROW, ONE CLOCK, THREE TIERS. `now` is the binding the window
        // above and the allowance below both use; a second clock read here
        // could put this render on one side of a comp expiry and the quota on
        // the other. entitlementTier LAYERS on hasProAccess rather than
        // widening it -- see src/lib/pro-access.ts for why a pack buyer must
        // not pick up Pro's monthly window or allowance.
        setTier(entitlementTier(subscription, now));

        // The same decision the scan endpoint enforces, from the same module.
        const result = computeQuota({
          scans_used: typeof count === "number" ? count : 0,
          subscription,
          now,
        });
        setQuota({
          exhausted: result.remaining <= 0,
          remaining: result.remaining,
          total: result.total_quota,
          purchased:
            result.is_paid || (subscription?.scan_credits ?? 0) > 0,
        });

        const resolved = data as ScansRow | null;
        if (!resolved) {
          // No scan to show — render an honest empty state instead of silently
          // falling back to demo seed data (which previously confused real
          // users into thinking the seed result was theirs).
          setScan(null);
          setState("missing");
          return;
        }
        setScan(resolved);
        setState("ready");
      } catch {
        if (cancelled) return;
        // On error: still avoid showing fake data. Empty-state is the safe default.
        setScan(null);
        // Nothing was verified, so claim nothing was spent — see
        // QUOTA_UNRESOLVED. A paywall raised by a failed read is the exact
        // failure that charges a user for scans they already have.
        setQuota(QUOTA_UNRESOLVED);
        setState("missing");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [scanId]);

  // activate fires when the first score is delivered to the user (b-04 / h-03).
  useEffect(() => {
    if (state === "ready" && scan && !activateFiredRef.current) {
      activateFiredRef.current = true;
      // A partial scan's score is not comparable to a complete one — omit the
      // property rather than mixing the two scales in one funnel metric.
      trackActivate(
        isFullAnalysis(scan.file_meta)
          ? { doc_type: scan.doc_type, fraud_score: scan.fraud_score }
          : { doc_type: scan.doc_type },
      );
    }
  }, [state, scan]);

  // Activation for the Phase 2 fake door: this user has received a fraud score.
  // Deliberately NOT "over the free limit" — gating the Upgrade CTA on quota
  // exhaustion would restrict the pay-intent numerator to the ~30% of users who
  // burn all three scans, tripling the click cost per observed intent.
  const hasActivated = state === "ready" && scan !== null;

  return (
    <div className="dark min-h-screen overflow-x-hidden bg-background text-foreground">
      <FeedbackWidget
        show={state === "ready" && scan !== null}
        activationAction={
          scan ? `first_scan_${scan.doc_type}` : "first_scan"
        }
      />
      {/* page-local choreography keyframes */}
      <style>{`
        @keyframes fs-signal-in {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes fs-blur-in {
          from { opacity: 0; filter: blur(8px); transform: translateY(16px); }
          to   { opacity: 1; filter: blur(0); transform: translateY(0); }
        }
        @keyframes fs-sweep {
          0%   { transform: translateY(-110%); opacity: 0; }
          12%  { opacity: 1; }
          88%  { opacity: 1; }
          100% { transform: translateY(110%); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .fs-reveal, .fs-sweep-beam { animation: none !important; opacity: 1 !important; filter: none !important; transform: none !important; }
        }
      `}</style>

      {/* faint forensic grid + signal-cyan corner mesh */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          backgroundImage:
            "radial-gradient(circle at 85% 8%, rgba(56,189,207,0.10), transparent 45%)",
        }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.04]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />

      <div className="relative z-10 mx-auto w-full max-w-5xl px-5 py-10 md:py-16">
        {state === "loading" ? (
          <LoadingChoreography />
        ) : state === "missing" ? (
          <EmptyState />
        ) : (
          scan && (
            <>
              {/* UpgradeCta used to render here, after the whole result. It now
                  lives inside the locked signal breakdown: the offer lands
                  hardest at the point where the user can see something is being
                  withheld, not a screen further down. ResultView owns the only
                  instance — a second one would duplicate its fire-once state. */}
              <ResultView
                scan={scan}
                quota={quota}
                hasActivated={hasActivated}
                tier={tier}
              />
            </>
          )
        )}
      </div>
    </div>
  );
}

function LoadingChoreography() {
  return (
    <div className="flex flex-col items-center" aria-busy="true">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        Running forensic analysis
      </p>
      <h1 className="mt-2 font-heading text-2xl font-semibold tracking-tight">
        Analyzing document…
      </h1>

      {/* Scan-sweep over a document mockup — the signature "Forensic Scan Sweep" */}
      <div className="relative mt-10 h-72 w-56 overflow-hidden rounded-lg bg-card ring-1 ring-border">
        <div className="space-y-3 p-5">
          {[92, 70, 84, 56, 78, 64, 88].map((w, i) => (
            <div
              key={i}
              className="h-3 rounded bg-muted"
              style={{ width: `${w}%` }}
            />
          ))}
        </div>
        <div
          className="fs-sweep-beam absolute inset-x-0 top-0 h-16"
          style={{
            background:
              "linear-gradient(to bottom, transparent, rgba(56,189,207,0.45), transparent)",
            animation: "fs-sweep 1.8s cubic-bezier(0.22,1,0.36,1) infinite",
          }}
        />
      </div>

      {/* Staggered skeleton: gauge → signal rows */}
      <div className="mt-10 h-6 w-40 animate-pulse rounded bg-muted" />
      <div className="mt-6 grid w-full max-w-2xl gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg bg-card ring-1 ring-border"
            style={{ animationDelay: `${i * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      role="status"
      className="flex min-h-[60vh] flex-col items-center justify-center text-center fs-reveal"
      style={{ animation: "fs-blur-in 700ms cubic-bezier(0.22,1,0.36,1) both" }}
    >
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
        Forensic result
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight">
        No scan to display yet
      </h1>
      <p className="mt-4 max-w-md text-base text-muted-foreground">
        Drop a pay stub, bank statement, or invoice on your dashboard and
        FraudShield will return a forensic fraud score in seconds — with a full
        per-signal breakdown of every finding.
      </p>
      <Link
        href="/dashboard"
        className={`${buttonVariants({ variant: "default" })} mt-8 rounded-full px-6`}
      >
        Go to dashboard
      </Link>
    </div>
  );
}

function ResultView({
  scan,
  quota,
  hasActivated,
  tier,
}: {
  scan: ScansRow;
  quota: QuotaState;
  hasActivated: boolean;
  tier: EntitlementTier;
}) {
  const docLabel = DOC_TYPE_LABEL[scan.doc_type] ?? "Document";
  const severity = severityOfScore(scan.fraud_score);
  const meta = scan.file_meta;
  const fraudSignals: FraudSignal[] = scan.signals ?? [];
  // ONE TIER, THREE CONSEQUENCES: whether the full breakdown renders, which
  // reasons are named, and which of the three sentences around them is true.
  //
  // isPro stays a boolean because the render branch is binary -- "pro" gets
  // SignalBreakdown and the other two tiers get the locked panel, which is
  // what keeps paywall_shown firing for a pack buyer.
  const isPro = tier === "pro";
  // Empty for everyone but a pack buyer, and empty for a pack buyer whose
  // signals column held nothing we are willing to name (topNamedReasons drops
  // a null or label-less top entry rather than promoting the runner-up).
  // Zero-signal scans never reach this branch at all: they take
  // NoIndicatorsFound or EmptySignals.
  const revealedReasons = tier === "pack" ? topNamedReasons(fraudSignals) : [];
  // Which tier's sentences this reader gets. A pack buyer with nothing named
  // reads the free ones, because those are the true ones for them.
  const copyTier = tierForCopy(tier, revealedReasons.length);
  // Three depths, three read-outs. PDFs get document forensics; images get EXIF
  // plus an AI content pass; an image whose content pass didn't complete gets
  // EXIF alone — real signals, but not a complete picture, so we show the
  // evidence without presenting a score as a finished verdict.
  const mode = analysisMode(meta);
  const fullAnalysis = mode !== "partial";
  // Zero signals has two causes that must NOT read the same way. A scan that
  // ran and found nothing is a successful clean result; a row with no analysis
  // on record is missing data. `file_meta.mime` is written by the scan route on
  // every completed scan, so its presence is what separates them.
  const scanCompleted = Boolean(meta && typeof meta.mime === "string");

  // The quota banner is a second, distinct paywall: the locked breakdown asks
  // "pay to see this result", this one asks "pay to run another scan". They
  // convert differently, so `surface` keeps them apart in the funnel.
  const quotaPaywallFired = useRef(false);
  useEffect(() => {
    if (!quota.exhausted || quotaPaywallFired.current) return;
    quotaPaywallFired.current = true;
    trackPaywallShown({ surface: "scan_result_quota" });
  }, [quota.exhausted]);

  // Someone who bought a scan pack spent scans they paid for, not free ones.
  const exhaustedEyebrow = quota.purchased ? "Scans used" : "Free scans used";
  const exhaustedHeadline = quota.purchased
    ? `You've used all ${quota.total} of your scans`
    : `Your free ${quota.total === 1 ? "scan has" : "scans have"} been used`;
  // Same claim, other direction: the remaining count is free allowance plus
  // anything purchased, and only the free part may be called free.
  const remainingCopy = `${quota.remaining} ${
    quota.purchased ? "" : "free "
  }scan${quota.remaining === 1 ? "" : "s"} remaining.`;

  return (
    <div className="flex flex-col gap-12">
      {/* Header */}
      <header className="fs-reveal" style={{ animation: "fs-blur-in 520ms cubic-bezier(0.22,1,0.36,1) both" }}>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Forensic result
        </p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight md:text-4xl">
          {fullAnalysis
            ? `${docLabel} analysis complete`
            : `${docLabel} — partial analysis`}
        </h1>
        {mode === "full_pdf" ? (
          <p className="mt-2 max-w-2xl text-base leading-relaxed text-muted-foreground">
            FraudShield ran metadata forensics, AI content review, and
            template matching on{" "}
            <span className="font-mono text-foreground">{meta.filename}</span>.{" "}
            {SCORE_EVIDENCE_NOTE[copyTier]}
          </p>
        ) : mode === "full_image" ? (
          <p className="mt-2 max-w-2xl text-base leading-relaxed text-muted-foreground">
            <span className="font-mono text-foreground">{meta.filename}</span> —{" "}
            {VISION_ANALYSIS_BODY}
          </p>
        ) : (
          <p className="mt-2 max-w-2xl text-base leading-relaxed text-muted-foreground">
            FraudShield ran image metadata forensics on{" "}
            <span className="font-mono text-foreground">{meta.filename}</span> —
            the evidence below is what the file&rsquo;s EXIF data reveals.
            Producer fingerprinting and template matching have no image
            equivalent, so this is a partial result rather than a final verdict.
          </p>
        )}
      </header>

      {/* Score + file fingerprint */}
      <section
        aria-label={fullAnalysis ? "Fraud score" : "Analysis scope"}
        className={cn(
          "fs-reveal grid gap-10 rounded-xl bg-card p-8 ring-1 ring-border",
          fullAnalysis && "md:grid-cols-[auto_1fr] md:items-center",
        )}
        style={{ animation: "fs-blur-in 560ms cubic-bezier(0.22,1,0.36,1) both", animationDelay: "80ms" }}
      >
        {fullAnalysis && (
          <ScoreGauge score={scan.fraud_score} startDelayMs={300} />
        )}

        <div className="min-w-0">
          {fullAnalysis ? (
            <>
              <h2 className="font-heading text-lg font-semibold">
                What this score means
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {severity === "fraud" &&
                  "Multiple high-weight forensic signals indicate this document was fabricated or heavily altered. Do not approve without independent verification."}
                {severity === "suspect" &&
                  "Some signals warrant a manual review. Treat this document as unverified until the flagged items are resolved."}
                {severity === "clear" &&
                  // Never a certification. The PDF wording rests on
                  // producer/template evidence an image doesn't have, so a
                  // content-analysed image gets its own honest line.
                  (mode === "full_image"
                    ? VISION_CLEAR_BODY
                    : "No strong fraud indicators were found. The document is consistent with an authentic, software-issued original.")}
              </p>
            </>
          ) : (
            <>
              <Alert>
                <AlertTitle className="font-heading text-lg">
                  {LIMITED_ANALYSIS_TITLE}
                </AlertTitle>
                <AlertDescription className="mt-1 leading-relaxed">
                  {LIMITED_ANALYSIS_BODY}
                </AlertDescription>
              </Alert>
              <Link
                href="/dashboard"
                className={`${buttonVariants()} mt-5 h-11 rounded-pill bg-signal px-6 text-signal-foreground hover:bg-signal/90`}
              >
                Upload the original PDF
              </Link>
            </>
          )}

          {/* File fingerprint — mono metadata, evidence-lab read */}
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-xs">
            <FingerprintField term="Document" value={docLabel} />
            <FingerprintField term="Type" value={meta.mime} />
            {/* PDF-only fields — hidden entirely when no deep metadata ran */}
            {mode === "full_pdf" && (
              <>
                <FingerprintField
                  term="Producer"
                  value={meta.pdf_producer ?? "—"}
                />
                <FingerprintField
                  term="Creator"
                  value={meta.pdf_creator ?? "—"}
                />
                <FingerprintField
                  term="Created"
                  value={formatTs(meta.pdf_created)}
                />
                <FingerprintField
                  term="Modified"
                  value={formatTs(meta.pdf_modified)}
                />
              </>
            )}
          </dl>
        </div>
      </section>

      {/* Upgrade prompt — b-06 entry, only when the free-scan limit is hit.
          Sits ABOVE the signal breakdown: a quota-exhausted user has already
          read their score, and the breakdown below can run a full screen,
          which pushed the only offer they can act on off the fold. */}
      {quota.exhausted && (
        <section
          aria-label="Upgrade"
          className="rounded-xl bg-card p-6 ring-1 ring-suspect/40 md:p-8"
        >
          <div className="flex flex-col items-start justify-between gap-5 md:flex-row md:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-wider text-suspect">
                {exhaustedEyebrow}
              </p>
              <h2 className="mt-1.5 font-heading text-xl font-semibold">
                {exhaustedHeadline}
              </h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Upgrade to keep scanning documents and unlock higher monthly
                quota for your team.
              </p>
            </div>
            {/* Anchors to the Upgrade CTA further down THIS page, not /pricing.
                Linking out sent the user to a card that told them to scan a
                document — the one thing a quota-exhausted user cannot do — and
                then back here again. It stays an anchor rather than a second
                UpgradeCta because that component owns fire-once checkout
                state; two live instances could open two Stripe sessions. */}
            <Link
              href="#upgrade-pro"
              className={`${buttonVariants()} h-11 shrink-0 rounded-pill bg-signal px-6 text-signal-foreground hover:bg-signal/90`}
            >
              Upgrade to keep scanning
            </Link>
          </div>
        </section>
      )}

      {/* Per-signal breakdown — the explainability that IS the product */}
      <section
        aria-label="Forensic signals"
        className="fs-reveal"
        style={{ animation: "fs-blur-in 600ms cubic-bezier(0.22,1,0.36,1) both", animationDelay: "160ms" }}
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            Forensic signal breakdown
          </h2>
          <span className="font-mono text-xs text-muted-foreground">
            {signalCountLabel(
              copyTier,
              fraudSignals.length,
              revealedReasons.length,
            )}
          </span>
        </div>
        <p className="mt-1 mb-5 text-sm text-muted-foreground">
          {fraudSignals.length > 0
            ? SIGNAL_BREAKDOWN_NOTE[copyTier]
            : fullAnalysis
              ? "Every point in the score traces to a specific, inspectable signal."
              : "Every finding from the image metadata checks is listed here as a specific, inspectable signal."}
        </p>
        {fraudSignals.length > 0 ? (
          // THE PAYWALL BRANCH. This read `fraudSignals.length > 0 ?
          // <LockedSignals/>` with no subscription check at all, so the
          // breakdown rendered locked for everyone -- including subscribers,
          // who had paid for "Per-signal breakdown & explanations" on the
          // pricing page. SignalBreakdown existed in this folder the whole
          // time and was imported nowhere.
          //
          // It read as a payment bug rather than a rendering one because
          // UpgradeCta, nested inside LockedSignals, learns the user is
          // subscribed from checkout's 409 and says "You are already on Pro"
          // -- inside the very section still telling them to upgrade.
          isPro ? (
            <SignalBreakdown signals={fraudSignals} />
          ) : (
            <LockedSignals
              signals={fraudSignals}
              reasons={revealedReasons}
              user={scan.user_id}
              hasActivated={hasActivated}
            />
          )
        ) : scanCompleted ? (
          <>
            <NoIndicatorsFound mode={mode} />
            <UpgradeCta user={scan.user_id} hasActivated={hasActivated} />
          </>
        ) : (
          <>
            <EmptySignals />
            <UpgradeCta user={scan.user_id} hasActivated={hasActivated} />
          </>
        )}
      </section>

      {/* Next actions */}
      <section
        aria-label="Next steps"
        className="flex flex-col items-stretch gap-3 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-sm text-muted-foreground">
          {quota.exhausted
            ? "Need to verify another document? Upgrade above to continue."
            : remainingCopy}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <ApiAccessDialog docType={scan.doc_type} />
          <Link
            href="/dashboard"
            className={`${buttonVariants()} h-11 rounded-pill bg-signal px-6 text-signal-foreground hover:bg-signal/90`}
          >
            Scan another document
          </Link>
        </div>
      </section>

      {/* Demand probe for a capability the product does NOT have. Full width
          and on its own line on purpose: it first shipped as a child of the
          next-steps flex row, which squeezed two paragraphs into a narrow
          column on desktop. A probe nobody can comfortably read measures the
          layout, not the demand. */}
      <CrossDocumentInterest docType={scan.doc_type} />
    </div>
  );
}

function FingerprintField({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="uppercase tracking-wider text-muted-foreground">{term}</dt>
      <dd className="truncate text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The one reason a scan-pack buyer is shown, unblurred, inside the locked
 * panel (b-13).
 *
 * It takes a NamedReason rather than a FraudSignal, and that is the whole
 * point of the projection: the type carries a label and a severity and nothing
 * else, so the weight -- from which the withheld points could be read off the
 * screen -- cannot be printed here by accident. src/lib/top-signal.ts does the
 * projecting; this only renders what survived it.
 *
 * Borrowed vocabulary, deliberately. The severity chip and the severity colour
 * are the same recipe SignalBreakdown uses for a Pro subscriber's rows, so the
 * reason a pack buyer reads looks like the evidence it is -- and like the
 * evidence they would get more of. The rail is a left border rather than the
 * absolutely-positioned span used there because this row sits in flow at the
 * top of the panel, not in a card of its own.
 */
function RevealedReason({ reason }: { reason: NamedReason }) {
  const color = severityVar(reason.severity);
  return (
    <li className="border-l-2 pl-4" style={{ borderColor: color }}>
      <span
        className="rounded-pill px-2 py-0.5 font-mono text-[0.65rem] font-medium uppercase tracking-wide"
        style={{
          color: "var(--foreground)",
          backgroundColor: `color-mix(in oklch, ${color} 16%, transparent)`,
        }}
      >
        {severityLabel(reason.severity)}
      </span>
      <p className="mt-2 font-heading text-base font-semibold leading-snug text-foreground">
        {reason.label}
      </p>
    </li>
  );
}

/**
 * The paywall over the signal breakdown.
 *
 * Blurs the REAL signal labels rather than inventing placeholder rows. A user
 * who can see the shape of genuine findings has a reason to unlock them, and a
 * fabricated preview would misrepresent what is actually behind the lock.
 *
 * A SCAN-PACK BUYER STAYS IN THIS COMPONENT, with their reasons revealed at
 * the top and the rest of the panel untouched. They are not lifted into a surface
 * of their own for two reasons. The offer below -- UpgradeCta and the scan
 * packs -- is the only instance on the page, and a second one would duplicate
 * the id="upgrade-pro" anchor and could open two Stripe sessions. And
 * `paywall_shown` fires from here: a cohort moved out of this component
 * silently leaves the funnel denominator that checkout_start is measured
 * against.
 *
 * Fires `paywall_shown` once per mount, never per render: the measurement is
 * checkout_start over paywall_shown, and re-render inflation would destroy
 * the denominator this event exists to supply.
 */
function LockedSignals({
  signals,
  reasons,
  user,
  hasActivated,
}: {
  signals: FraudSignal[];
  /**
   * What a scan-pack buyer has paid to read. Empty for every other tier, and
   * empty is the signal to render the panel exactly as it shipped -- which is
   * what keeps the free view, and the e2e test over it, unchanged.
   */
  reasons: NamedReason[];
  user: string | null;
  hasActivated: boolean;
}) {
  const count = signals.length;
  const firedRef = useRef(false);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    trackPaywallShown({ surface: "locked_signals", signal_count: count });
  }, [count]);

  return (
    <div className="relative overflow-hidden rounded-xl bg-card ring-1 ring-border">
      {/* What the pack buyer paid for, in the place the blur already
          occupied: above the lock, inside the same panel, with nothing moved
          around it. z-10 lifts it over the gradient scrim below, which is
          absolutely positioned across the whole panel and would otherwise
          wash out the one thing on it that is meant to be read.

          Rendered only when there is something to name, so the free tier gets
          byte-identical markup and a pack buyer whose signals could not be
          named falls back to the panel they saw before rather than to an empty
          promise. */}
      {reasons.length > 0 ? (
        <div className="relative z-10 border-b border-border px-6 pb-5 pt-6">
          <ul
            className="flex flex-col gap-4"
            aria-label="Top reasons this document was flagged"
          >
            {reasons.map((reason, index) => (
              <RevealedReason key={index} reason={reason} />
            ))}
          </ul>
          <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted-foreground">
            {PACK_TOP_REASON_NOTE}
          </p>
        </div>
      ) : null}

      {/* Decorative: aria-hidden and unselectable so the blurred labels are not
          read out or copied. The blur is presentation, not a security control —
          nothing is charged, so there is nothing to protect. */}
      <div aria-hidden="true" className="select-none space-y-4 p-6 blur-[6px]">
        {signals.slice(0, 4).map((s) => (
          <div key={s.id} className="flex items-start gap-3">
            <span className="mt-1.5 size-2.5 shrink-0 rounded-full bg-muted-foreground/60" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{s.label}</p>
              <span className="mt-2 block h-2 w-full rounded bg-muted-foreground/25" />
              <span className="mt-1.5 block h-2 w-4/5 rounded bg-muted-foreground/20" />
            </div>
          </div>
        ))}
      </div>

      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-card/30 via-card/85 to-card"
      />

      <div className="relative flex flex-col items-center gap-3 px-6 pb-6 pt-2 text-center">
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-full bg-signal/12 text-signal ring-1 ring-signal/25"
        >
          <Lock className="size-4" />
        </span>
        <UpgradeCta
          user={user}
          hasActivated={hasActivated}
          variant="inline"
          heading={`${count} forensic signal${count === 1 ? "" : "s"} found on this document`}
          body="Each names what was detected, where it was found, and how much it moved the score."
          ctaLabel={`Unlock all ${count} forensic signals`}
        />
      </div>

      {/* Scan packs, deliberately OUTSIDE the centred unlock stack above.

          They used to sit inside it, one gap-3 below "Unlock all N forensic
          signals", under the heading "Or just buy the scans you need". On
          6 Nov 2026 a customer with two scans still unused bought two $7 packs
          from here expecting the signals to open, and found the same result
          locked. Stacked centred buttons read as one menu, and "Or" named the
          packs as the cheaper item on it.

          Packs are still offered here, because this is where intent is highest
          and the manager asked to keep them. What changed is that they are now
          a separate region behind a rule, left-aligned rather than centred,
          with their own heading and an explicit line saying what they do not
          do. The separation is the fix; the sentence is the backstop.

          Only for a signed-in visitor: checkout needs a user to attach the
          purchase to, and a signed-out one is sent to sign up by the CTA
          above. */}
      {user ? (
        <div className="relative border-t border-border px-6 pb-6 pt-5">
          <ScanPackOptions
            surface="scan_result"
            heading={PACKS_HEADING_AFTER_LOCK}
            className="mt-0 w-full [&>p:first-child]:text-left"
          />
          {/* Two sentences, one per reader, and only one of them is true of
              any given one. PACKS_DO_NOT_UNLOCK describes what a pack DOES --
              it shows why a result was flagged, and the full breakdown stays
              Pro -- which is what somebody shown nothing needs in order to
              decide. Said instead to a pack buyer with their reasons already
              on screen a few lines above, a description of the purchase is an
              invitation to make it a second time. Theirs answers what that
              reader is actually standing in front of a buy button asking:
              what does the NEXT pack get me. */}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {reasons.length > 0
              ? PACKS_DO_NOT_ADD_REASONS
              : PACKS_DO_NOT_UNLOCK}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shown when a scan completed and produced no signals — the common case for a
 * genuine document. Names every check that ran so a clean result still shows
 * the work behind it, instead of the empty "no data" panel this replaced.
 */
function NoIndicatorsFound({ mode }: { mode: AnalysisMode }) {
  return (
    <div className="rounded-xl bg-card p-6 ring-1 ring-border md:p-7">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-clear/12 text-clear ring-1 ring-clear/25"
        >
          <ShieldCheck className="size-4" />
        </span>
        <div>
          <p className="font-heading text-lg font-medium">{NO_INDICATORS_TITLE}</p>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {NO_INDICATORS_BODY}
          </p>
        </div>
      </div>
      <ul className="mt-5 grid gap-2.5 border-t border-border pt-5 sm:grid-cols-2">
        {CHECKS_PERFORMED[mode].map((check) => (
          <li key={check} className="flex items-start gap-2.5 text-sm">
            <Check className="mt-0.5 size-4 shrink-0 text-clear" aria-hidden="true" />
            <span className="text-muted-foreground">{check}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Genuinely no analysis on record — an old row, or a scan that never stored one. */
function EmptySignals() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl bg-card py-12 text-center ring-1 ring-border">
      <Image
        src="/images/empty-state.webp"
        alt="No forensic signals available"
        width={180}
        height={180}
        className="opacity-80"
      />
      <p className="mt-4 font-heading text-lg font-medium">
        No signal data on this scan
      </p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">
        Run a fresh scan from your dashboard to see the full forensic breakdown.
      </p>
    </div>
  );
}

function formatTs(ts?: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}
