"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronRight, ImageIcon } from "lucide-react";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { isFullAnalysis } from "@/lib/fraud/analysis-mode";
import type { ScansRow } from "@/lib/types";
import { topReasonFor } from "@/lib/top-reason";
import { severityLabel } from "@/app/scan-result/severity";
import type { EntitlementTier } from "@/lib/pro-access";

type Severity = "clear" | "suspect" | "fraud";

function severityFor(score: number): Severity {
  if (score <= 33) return "clear";
  if (score <= 66) return "suspect";
  return "fraud";
}

const SEVERITY_LABEL: Record<Severity, string> = {
  clear: "Authentic",
  suspect: "Review",
  fraud: "Forged",
};

const DOC_LABEL: Record<string, string> = {
  pay_stub: "Pay stub",
  bank_statement: "Bank statement",
  invoice: "Invoice",
};

function docLabel(docType: string | undefined): string {
  if (!docType) return "Document";
  return DOC_LABEL[docType] ?? "Document";
}

function relativeTime(iso: string | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * THE TIER ARRIVES AS A PROP, and this component must never fetch it.
 *
 * Answering "what has this user paid for" here would mean a second
 * from("subscriptions") read, and that read fails silently in the expensive
 * direction. The column guard in tests/entitlement-select-coverage.test.ts
 * requires status, stripe_subscription_id and current_period_end -- and
 * deliberately NOT scan_credits, because two Pro-only reads have no business
 * fetching it. So a read here can satisfy every guard in the suite, hand
 * entitlementTier a row whose scan_credits is undefined, and demote every
 * scan-pack buyer to "free" with nothing anywhere to show it happened.
 *
 * src/app/dashboard/page.tsx already makes the one compliant read, already
 * selects scan_credits, and already owns the single clock the decision shares.
 */
export function ScanHistory({ tier }: { tier: EntitlementTier }) {
  const [scans, setScans] = useState<ScansRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      const supabase = createClient();
      const { data, error: queryError } = await supabase
        .from("scans")
        .select("id, user_id, doc_type, fraud_score, signals, file_meta, created_at")
        .order("created_at", { ascending: false })
        .limit(20);
      if (!active) return;
      if (queryError) {
        setError("We couldn't load your scan history.");
        setScans([]);
        return;
      }
      setScans((data as ScansRow[] | null) ?? []);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Loading — staggered graphite skeleton rows.
  if (scans === null) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading scan history">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-[var(--radius-lg)] bg-card p-3 ring-1 ring-border"
            style={{ animationDelay: `${i * 90}ms` }}
          >
            <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded-full bg-muted" />
              <div className="h-3 w-1/4 animate-pulse rounded-full bg-muted/70" />
            </div>
            <div className="h-6 w-12 animate-pulse rounded-full bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (error && scans.length === 0) {
    return (
      // Network/query error is a system state, NOT a fraud signal — use
      // the destructive token (reserved for system errors), keeping the
      // fraud severity vocabulary exclusive to scan-result fraud scores.
      <div className="rounded-[var(--radius-lg)] bg-card p-6 text-center ring-1 ring-border">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  // Empty state — conceptual upload/scan-target illustration from the image manifest.
  if (scans.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[var(--radius-lg)] bg-card px-6 py-12 text-center ring-1 ring-border">
        <Image
          src="/images/empty-state.webp"
          alt=""
          aria-hidden="true"
          width={220}
          height={220}
          className="mb-5 h-40 w-40 object-contain opacity-95"
          priority={false}
        />
        <p className="text-lg font-semibold text-foreground font-[family-name:var(--font-heading)]">
          No scans yet
        </p>
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          Drop in your first pay stub, bank statement, or invoice and get a forensic
          fraud score in seconds.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {scans.map((scan) => {
        const severity = severityFor(scan.fraud_score ?? 0);
        // A partial scan (an image whose AI content pass did not complete) got
        // EXIF metadata checks only — show a neutral chip rather than a
        // verdict-coded score.
        const fullAnalysis = isFullAnalysis(scan.file_meta);
        // The one reason this document was flagged, for a scan-pack buyer and
        // for Pro (b-13). Null for a free reader, for a clean document with no
        // signals, and for every malformed shape the jsonb column can hold --
        // all of which must render no line at all, not an empty one.
        const reason = topReasonFor(tier, scan.signals);
        return (
          <li key={scan.id}>
            <Link
              href={`/scan-result?id=${encodeURIComponent(scan.id)}`}
              className={cn(
                "group flex items-center gap-3 rounded-[var(--radius-lg)] bg-card p-3 ring-1 ring-border transition-all duration-150",
                "hover:-translate-y-0.5 hover:ring-signal/40 hover:shadow-[var(--shadow-signal-glow)]",
              )}
            >
              {/* Severity-coded score dial — neutral, score-less when limited */}
              <div
                className={cn(
                  "flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-[family-name:var(--font-mono)] text-sm font-semibold tabular-nums",
                  !fullAnalysis && "bg-muted text-muted-foreground ring-1 ring-border",
                  fullAnalysis && severity === "clear" && "bg-clear/15 text-clear ring-1 ring-clear/30",
                  fullAnalysis && severity === "suspect" && "bg-suspect/15 text-suspect ring-1 ring-suspect/30",
                  fullAnalysis && severity === "fraud" && "bg-fraud/15 text-fraud ring-1 ring-fraud/30",
                )}
                aria-hidden="true"
              >
                {fullAnalysis ? scan.fraud_score ?? 0 : <ImageIcon className="h-4 w-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">
                  {docLabel(scan.doc_type)}
                  <span className="sr-only">
                    {" "}
                    {fullAnalysis
                      ? `— fraud score ${scan.fraud_score ?? 0}, ${SEVERITY_LABEL[severity]}`
                      : "— partial analysis, image metadata checks only"}
                  </span>
                </p>
                <p className="truncate font-[family-name:var(--font-mono)] text-xs text-muted-foreground">
                  {scan.file_meta?.filename ?? "document"} · {relativeTime(scan.created_at)}
                </p>
                {/* THE TOP REASON (b-13). One line, set apart from the row's
                    identity above it by a severity rail -- the same device
                    /scan-result uses for a signal, so a finding looks like a
                    finding on both surfaces. The rail is the only accessory
                    here; colour alone never carries the severity, which is
                    why the word is spoken below.

                    THE CAPTION FOLLOWS fullAnalysis, because the chip on this
                    row already does. A partial analysis is an image whose AI
                    content pass never completed: it gets EXIF checks, no
                    score, and a neutral "Limited" chip. Calling an EXIF
                    finding the reason the document was "flagged" would assert
                    the very verdict that chip withholds, so that row says what
                    was found instead of what it means.

                    severityLabel comes from the SIGNAL
                    vocabulary (Clear / Suspect / Fraud), not from this file's
                    SEVERITY_LABEL. That map names a SCORE BAND for the whole
                    document -- "Forged" on the chip to the right -- and the
                    two are different subjects: a verdict about a document
                    versus one piece of evidence within it. Adopting either vocabulary into the other would make one of them a lie.

                    THE RAIL IS DECORATIVE, DELIBERATELY. It used to be tinted
                    with the signal severity, which made colour the only cue a
                    sighted reader had for it -- the severity word beside it is
                    sr-only, and the chip to the right is the document verdict,
                    not this signal. That is WCAG 1.4.1, and the tint also
                    measured 1.99:1 for suspect against the card, under the 3:1
                    that 1.4.11 asks of a meaningful graphic. A neutral border
                    carries no meaning, so neither rule applies, and the
                    severity still reaches assistive tech through the sr-only
                    span below. Making the word visible instead was rejected:
                    two severity vocabularies on one row is the confusion the
                    note above exists to avoid. */}
                {reason ? (
                  <p
                    className="mt-1.5 truncate border-l-2 border-border pl-2 text-xs text-foreground/80"
                  >
                    <span className="sr-only">
                      {fullAnalysis
                        ? "Top reason flagged: "
                        : "Top metadata finding: "}
                    </span>
                    {reason.label}
                    <span className="sr-only">
                      , {severityLabel(reason.severity)} signal
                    </span>
                  </p>
                ) : null}
              </div>
              {fullAnalysis ? (
                <span
                  className={cn(
                    "hidden shrink-0 rounded-[var(--radius-pill)] px-2.5 py-1 text-xs font-medium sm:inline-block",
                    severity === "clear" && "bg-clear/10 text-clear",
                    severity === "suspect" && "bg-suspect/10 text-suspect",
                    severity === "fraud" && "bg-fraud/10 text-fraud",
                  )}
                >
                  {SEVERITY_LABEL[severity]}
                </span>
              ) : (
                <Badge
                  variant="secondary"
                  className="hidden h-auto shrink-0 rounded-[var(--radius-pill)] bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground sm:inline-flex"
                >
                  Limited
                </Badge>
              )}
              <ChevronRight
                className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-signal"
                aria-hidden="true"
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
