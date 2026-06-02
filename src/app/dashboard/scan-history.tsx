"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { createClient } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { ScansRow } from "@/lib/types";

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

export function ScanHistory() {
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
            className="flex items-center gap-4 rounded-[var(--radius-lg)] bg-card p-4 ring-1 ring-border"
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
        return (
          <li key={scan.id}>
            <Link
              href={`/scan-result?id=${encodeURIComponent(scan.id)}`}
              className={cn(
                "group flex items-center gap-4 rounded-[var(--radius-lg)] bg-card p-4 ring-1 ring-border transition-all duration-150",
                "hover:-translate-y-0.5 hover:ring-signal/40 hover:shadow-[var(--shadow-signal-glow)]",
              )}
            >
              {/* Severity-coded score dial */}
              <div
                className={cn(
                  "flex h-12 w-12 shrink-0 items-center justify-center rounded-full font-[family-name:var(--font-mono)] text-sm font-semibold tabular-nums",
                  severity === "clear" && "bg-clear/15 text-clear ring-1 ring-clear/30",
                  severity === "suspect" && "bg-suspect/15 text-suspect ring-1 ring-suspect/30",
                  severity === "fraud" && "bg-fraud/15 text-fraud ring-1 ring-fraud/30",
                )}
                aria-hidden="true"
              >
                {scan.fraud_score ?? 0}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground">
                  {docLabel(scan.doc_type)}
                  <span className="sr-only">
                    {" "}
                    — fraud score {scan.fraud_score ?? 0}, {SEVERITY_LABEL[severity]}
                  </span>
                </p>
                <p className="truncate font-[family-name:var(--font-mono)] text-xs text-muted-foreground">
                  {scan.file_meta?.filename ?? "document"} · {relativeTime(scan.created_at)}
                </p>
              </div>
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
