"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase";
import { trackActivate } from "@/lib/events";
import { FREE_SCAN_QUOTA, type FraudSignal, type ScansRow } from "@/lib/types";
import { ScoreGauge } from "./score-gauge";
import { SignalBreakdown } from "./signal-breakdown";
import { ApiAccessDialog } from "./api-access-dialog";
import { severityOfScore } from "./severity";
import { FeedbackWidget } from "@/components/feedback-widget";

const DOC_TYPE_LABEL: Record<string, string> = {
  pay_stub: "Pay stub",
  bank_statement: "Bank statement",
  invoice: "Invoice",
};

type LoadState = "loading" | "ready" | "missing";

export function ScanResultClient() {
  const searchParams = useSearchParams();
  const scanId = searchParams.get("id");

  const [state, setState] = useState<LoadState>("loading");
  const [scan, setScan] = useState<ScansRow | null>(null);
  const [scansUsed, setScansUsed] = useState<number | null>(null);
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
        const { count } = await supabase
          .from("scans")
          .select("id", { count: "exact", head: true });

        if (cancelled) return;

        const resolved = data as ScansRow | null;
        if (!resolved) {
          // No scan to show — render an honest empty state instead of silently
          // falling back to demo seed data (which previously confused real
          // users into thinking the seed result was theirs).
          setScan(null);
          setScansUsed(typeof count === "number" ? count : 0);
          setState("missing");
          return;
        }
        setScan(resolved);
        setScansUsed(typeof count === "number" ? count : 1);
        setState("ready");
      } catch {
        if (cancelled) return;
        // On error: still avoid showing fake data. Empty-state is the safe default.
        setScan(null);
        setScansUsed(0);
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
      trackActivate({ doc_type: scan.doc_type, fraud_score: scan.fraud_score });
    }
  }, [state, scan]);

  const overFreeLimit =
    scansUsed !== null && scansUsed >= FREE_SCAN_QUOTA;

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
            <ResultView
              scan={scan}
              scansUsed={scansUsed ?? 0}
              overFreeLimit={overFreeLimit}
            />
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
  scansUsed,
  overFreeLimit,
}: {
  scan: ScansRow;
  scansUsed: number;
  overFreeLimit: boolean;
}) {
  const docLabel = DOC_TYPE_LABEL[scan.doc_type] ?? "Document";
  const severity = severityOfScore(scan.fraud_score);
  const meta = scan.file_meta;
  const fraudSignals: FraudSignal[] = scan.signals ?? [];

  return (
    <div className="flex flex-col gap-12">
      {/* Header */}
      <header className="fs-reveal" style={{ animation: "fs-blur-in 520ms cubic-bezier(0.22,1,0.36,1) both" }}>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-signal">
          Forensic result
        </p>
        <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight md:text-4xl">
          {docLabel} analysis complete
        </h1>
        <p className="mt-2 max-w-2xl text-base leading-relaxed text-muted-foreground">
          FraudShield ran metadata forensics, cross-document checks, and
          template matching on{" "}
          <span className="font-mono text-foreground">{meta.filename}</span>.
          Here is the full evidence trail behind the score.
        </p>
      </header>

      {/* Score + file fingerprint */}
      <section
        aria-label="Fraud score"
        className="fs-reveal grid gap-10 rounded-xl bg-card p-8 ring-1 ring-border md:grid-cols-[auto_1fr] md:items-center"
        style={{ animation: "fs-blur-in 560ms cubic-bezier(0.22,1,0.36,1) both", animationDelay: "80ms" }}
      >
        <ScoreGauge score={scan.fraud_score} startDelayMs={300} />

        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold">
            What this score means
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {severity === "fraud" &&
              "Multiple high-weight forensic signals indicate this document was fabricated or heavily altered. Do not approve without independent verification."}
            {severity === "suspect" &&
              "Some signals warrant a manual review. Treat this document as unverified until the flagged items are resolved."}
            {severity === "clear" &&
              "No strong fraud indicators were found. The document is consistent with an authentic, software-issued original."}
          </p>

          {/* File fingerprint — mono metadata, evidence-lab read */}
          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-xs">
            <FingerprintField term="Document" value={docLabel} />
            <FingerprintField term="Type" value={meta.mime} />
            <FingerprintField
              term="Producer"
              value={meta.pdf_producer ?? "—"}
            />
            <FingerprintField term="Creator" value={meta.pdf_creator ?? "—"} />
            <FingerprintField
              term="Created"
              value={formatTs(meta.pdf_created)}
            />
            <FingerprintField
              term="Modified"
              value={formatTs(meta.pdf_modified)}
            />
          </dl>
        </div>
      </section>

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
            {fraudSignals.length} signals
          </span>
        </div>
        <p className="mt-1 mb-5 text-sm text-muted-foreground">
          Every point in the score traces to a specific, inspectable signal.
        </p>
        {fraudSignals.length > 0 ? (
          <SignalBreakdown signals={fraudSignals} />
        ) : (
          <EmptySignals />
        )}
      </section>

      {/* Upgrade prompt — b-06 entry, only when the free-scan limit is hit */}
      {overFreeLimit && (
        <section
          aria-label="Upgrade"
          className="rounded-xl bg-card p-6 ring-1 ring-suspect/40 md:p-8"
        >
          <div className="flex flex-col items-start justify-between gap-5 md:flex-row md:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-wider text-suspect">
                Free scans used
              </p>
              <h2 className="mt-1.5 font-heading text-xl font-semibold">
                You&apos;ve used all {FREE_SCAN_QUOTA} free scans
              </h2>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Upgrade to keep scanning documents and unlock higher monthly
                quota for your team.
              </p>
            </div>
            <Link
              href="/pricing"
              className={`${buttonVariants()} h-11 shrink-0 rounded-pill bg-signal px-6 text-signal-foreground hover:bg-signal/90`}
            >
              Upgrade to keep scanning
            </Link>
          </div>
        </section>
      )}

      {/* Next actions */}
      <section
        aria-label="Next steps"
        className="flex flex-col items-stretch gap-3 border-t border-border pt-8 sm:flex-row sm:items-center sm:justify-between"
      >
        <p className="text-sm text-muted-foreground">
          {overFreeLimit
            ? "Need to verify another document? Upgrade above to continue."
            : `${Math.max(0, FREE_SCAN_QUOTA - scansUsed)} free scan${
                FREE_SCAN_QUOTA - scansUsed === 1 ? "" : "s"
              } remaining.`}
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
