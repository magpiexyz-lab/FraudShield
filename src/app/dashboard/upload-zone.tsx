"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { FileUp, FileText, ShieldCheck, X, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AI_PRIVACY_DISCLOSURE } from "@/lib/fraud/analysis-mode";
import type { CreateScanResponse } from "@/app/api/scan/route";

// Accepted document types — pay stub, bank statement, invoice.
// PDF + common raster image formats. Client-side gate only; the
// /api/scan route (owned by scaffold-wire) re-validates server-side.
const ACCEPTED_MIME = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
] as const;
const ACCEPTED_EXT = ".pdf,.png,.jpg,.jpeg,.webp,.heic";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
// A batch is scanned one request at a time against /api/scan (no batch
// endpoint), so the cap is what keeps a single drop from turning into a
// minutes-long serial queue — the AI content pass alone budgets up to 25s.
const MAX_FILES = 10;

type UploadStatus = "idle" | "ready" | "scanning" | "done" | "error";
// skipped = never sent, because the quota ran out before its turn.
type FileStatus = "pending" | "scanning" | "done" | "error" | "skipped";

type FileEntry = {
  key: string;
  file: File;
  status: FileStatus;
  scanId?: string;
  fraudScore?: number;
  error?: string;
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validate(file: File): string | null {
  const typeOk =
    (ACCEPTED_MIME as readonly string[]).includes(file.type) ||
    /\.(pdf|png|jpe?g|webp|heic)$/i.test(file.name);
  if (!typeOk) {
    return "Unsupported file. Upload a PDF or image (PNG, JPG, WEBP).";
  }
  if (file.size > MAX_BYTES) {
    return `File is too large (${formatBytes(file.size)}). Maximum is 10 MB.`;
  }
  if (file.size === 0) {
    return "That file appears to be empty.";
  }
  return null;
}

export function UploadZone({
  quotaRemaining,
  onScansCompleted,
}: {
  quotaRemaining: number;
  // The dashboard reads its quota client-side, so router.refresh() alone will
  // not re-run that fetch. This lets the page refetch once a batch settles.
  onScansCompleted?: () => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const keySeq = useRef(0);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");
  const [activeName, setActiveName] = useState("");
  const [progressAnnouncement, setProgressAnnouncement] = useState("");
  const [quotaNotice, setQuotaNotice] = useState("");

  const quotaExhausted = quotaRemaining <= 0;
  const scanning = status === "scanning";

  const accept = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;

      // Cap the drop itself before anything else — a 40-file drop is a
      // mistake worth naming, not something to silently truncate to 10.
      if (incoming.length > MAX_FILES) {
        setError(
          `You dropped ${incoming.length} files. You can scan up to ${MAX_FILES} documents at a time — remove some and try again.`,
        );
        setStatus((s) => (s === "ready" ? s : "error"));
        return;
      }

      const accepted: FileEntry[] = [];
      const rejected: string[] = [];
      for (const file of incoming) {
        const problem = validate(file);
        if (problem) {
          rejected.push(`${file.name} (${problem})`);
          continue;
        }
        keySeq.current += 1;
        accepted.push({
          key: `f${keySeq.current}`,
          file,
          status: "pending",
        });
      }

      setEntries((prev) => {
        const room = MAX_FILES - prev.length;
        if (accepted.length > room) {
          setError(
            `You can scan up to ${MAX_FILES} documents at a time. Remove some before adding more.`,
          );
          return prev;
        }
        const next = [...prev, ...accepted];
        setError(
          rejected.length > 0
            ? `Skipped ${rejected.length} file${rejected.length === 1 ? "" : "s"}: ${rejected.join("; ")}`
            : "",
        );
        setStatus(next.length > 0 ? "ready" : "error");
        setQuotaNotice("");
        return next;
      });

      // Let the same file be re-picked after it is removed from the list.
      if (inputRef.current) inputRef.current.value = "";
    },
    [],
  );

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    accept(Array.from(e.target.files ?? []));
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (quotaExhausted || scanning) return;
    accept(Array.from(e.dataTransfer.files ?? []));
  }

  function removeFile(key: string) {
    setEntries((prev) => {
      const next = prev.filter((f) => f.key !== key);
      if (next.length === 0) {
        setStatus("idle");
        setError("");
        setQuotaNotice("");
        if (inputRef.current) inputRef.current.value = "";
      }
      return next;
    });
  }

  function clearAll() {
    setEntries([]);
    setStatus("idle");
    setError("");
    setQuotaNotice("");
    setProgressAnnouncement("");
    if (inputRef.current) inputRef.current.value = "";
  }

  // Forensic-scan progress choreography while a request is in flight.
  useEffect(() => {
    if (status !== "scanning") return;
    const phases = [
      "Reading document metadata…",
      "Running cross-document checks…",
      "Matching against fraud templates…",
      "Computing forensic score…",
    ];
    let i = 0;
    setProgressLabel(phases[0]);
    const t = setInterval(() => {
      i = (i + 1) % phases.length;
      setProgressLabel(phases[i]);
    }, 1100);
    return () => clearInterval(t);
  }, [status]);

  function patch(key: string, changes: Partial<FileEntry>) {
    setEntries((prev) =>
      prev.map((f) => (f.key === key ? { ...f, ...changes } : f)),
    );
  }

  async function runScan() {
    if (entries.length === 0 || quotaExhausted || scanning) return;

    // Snapshot the queue — `entries` is patched per file as the batch runs.
    const queue = entries;
    const total = queue.length;
    // Quota is per document. Scan what fits, then stop.
    const budget = Math.max(0, quotaRemaining);

    setStatus("scanning");
    setError("");
    setQuotaNotice("");

    // Two counters, because they answer different questions.
    //   scanned  — documents that produced a result. Drives the "X of Y" copy.
    //   charged  — documents that actually spent a free scan. Drives the stop.
    // They diverge on partial image analyses: those return a result but the
    // server does not charge them (migration 005). Counting a partial against
    // the budget would tell a user to upgrade when they have spent nothing —
    // and it would land on image uploaders, the exact people that change was
    // written to protect.
    let scanned = 0;
    let charged = 0;
    // Captured at the break rather than read back off `queue` afterwards:
    // `queue` is a snapshot, and patch() replaces objects in state instead of
    // mutating it, so the snapshot never sees the "skipped" status.
    let skippedForQuota = 0;
    let stoppedForQuota = false;
    let lastScanId = "";
    let failures = 0;

    for (let i = 0; i < total; i++) {
      const entry = queue[i];

      if (charged >= budget) {
        stoppedForQuota = true;
        skippedForQuota = total - i;
        for (let j = i; j < total; j++) patch(queue[j].key, { status: "skipped" });
        break;
      }

      setActiveName(entry.file.name);
      setProgressAnnouncement(
        `Scanning document ${i + 1} of ${total}: ${entry.file.name}`,
      );
      patch(entry.key, { status: "scanning", error: undefined });

      try {
        const body = new FormData();
        body.append("file", entry.file);
        const res = await fetch("/api/scan", { method: "POST", body });

        // The server enforces quota too. A 402 mid-batch means the allowance
        // ran out — stop here rather than firing the rest into a wall.
        if (res.status === 402) {
          stoppedForQuota = true;
          skippedForQuota = total - i;
          for (let j = i; j < total; j++) patch(queue[j].key, { status: "skipped" });
          break;
        }

        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(
            payload?.error ?? "We couldn't analyze that document. Please try again.",
          );
        }

        const result = (await res.json()) as Partial<CreateScanResponse>;
        if (!result.id) {
          throw new Error("The scan completed but returned no result id.");
        }

        scanned += 1;
        // The server is authoritative on whether this spent a free scan.
        // Absent field (older deploy) is treated as charged — erring toward
        // stopping early rather than overrunning the allowance.
        if (result.counts_toward_quota !== false) charged += 1;
        lastScanId = result.id;
        patch(entry.key, {
          status: "done",
          scanId: result.id,
          fraudScore: result.fraud_score,
        });
      } catch (err) {
        failures += 1;
        patch(entry.key, {
          status: "error",
          error:
            err instanceof Error
              ? err.message
              : "We couldn't analyze that document. Please try again.",
        });
      }
    }

    setActiveName("");
    setProgressAnnouncement("");

    if (stoppedForQuota) {
      // What an upgrade would actually unlock: the files never attempted. Not
      // total - scanned, which would fold in failures that were attempted and
      // overstate the offer.
      const remaining = skippedForQuota;
      setQuotaNotice(
        `${scanned} of ${total} scanned — upgrade to Pro to scan the remaining ${remaining}.`,
      );
    }

    // Refresh so the dashboard's quota meter and the quotaRemaining prop
    // reflect the scans this batch just spent.
    router.refresh();
    onScansCompleted?.();

    // A single document keeps the original behaviour: go straight to its
    // forensic result. scan-result is a single page that reads ?id=<scanId>
    // via useSearchParams() — see src/app/scan-result/page.tsx (no [id]
    // dynamic segment exists, so a path-style URL would 404).
    if (total === 1 && scanned === 1 && lastScanId) {
      router.push(`/scan-result?id=${encodeURIComponent(lastScanId)}`);
      return;
    }

    if (scanned === 0 && failures > 0 && !stoppedForQuota) {
      setError("We couldn't analyze those documents. Please try again.");
      setStatus("error");
      return;
    }

    setStatus("done");
  }

  const hasFiles = entries.length > 0;
  const showSummary = status === "done";

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXT}
        multiple
        onChange={onInputChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        disabled={scanning || quotaExhausted}
      />

      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!quotaExhausted && !scanning) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "relative w-full overflow-hidden rounded-[var(--radius-lg)] p-6 transition-all duration-200 sm:p-8",
          "bg-card ring-1 ring-border",
          dragging && "ring-2 ring-signal shadow-[var(--shadow-signal-glow)]",
          quotaExhausted && "opacity-60",
        )}
      >
        {/* Forensic inspection-grid texture */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.04]"
          style={{
            backgroundImage:
              "linear-gradient(var(--signal) 1px, transparent 1px), linear-gradient(90deg, var(--signal) 1px, transparent 1px)",
            backgroundSize: "26px 26px",
          }}
        />

        {scanning ? (
          <ScanningState
            fileName={activeName || entries[0]?.file.name || "document"}
            label={progressLabel}
          />
        ) : showSummary ? (
          <div className="relative space-y-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-signal/15 ring-1 ring-signal/30">
                <ShieldCheck className="h-5 w-5 text-signal" aria-hidden="true" />
              </div>
              <p className="text-lg font-semibold text-foreground font-[family-name:var(--font-heading)]">
                Scan complete
              </p>
            </div>

            <ul className="space-y-2">
              {entries.map((entry) => (
                <li
                  key={entry.key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] bg-background/40 px-3 py-2.5 ring-1 ring-border"
                >
                  <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-sm text-foreground">
                    {entry.file.name}
                  </span>
                  {entry.status === "done" && entry.scanId ? (
                    <span className="flex items-center gap-3">
                      <span className="font-[family-name:var(--font-mono)] text-sm text-muted-foreground">
                        Score {entry.fraudScore ?? "—"}
                      </span>
                      <Link
                        href={`/scan-result?id=${encodeURIComponent(entry.scanId)}`}
                        className="inline-flex items-center gap-1 text-sm font-medium text-signal underline-offset-4 hover:underline"
                      >
                        View result
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </span>
                  ) : entry.status === "skipped" ? (
                    // Not a fraud signal — a billing/system state.
                    <span className="text-sm text-muted-foreground">Not scanned</span>
                  ) : (
                    <span className="text-sm text-destructive">
                      {entry.error ?? "Failed"}
                    </span>
                  )}
                </li>
              ))}
            </ul>

            <div className="flex justify-center">
              <Button
                variant="ghost"
                onClick={clearAll}
                className="h-11 text-muted-foreground hover:text-foreground"
              >
                Scan more documents
              </Button>
            </div>
          </div>
        ) : hasFiles ? (
          <div className="relative space-y-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-signal/15 ring-1 ring-signal/30">
                <FileText className="h-5 w-5 text-signal" aria-hidden="true" />
              </div>
              <p className="text-sm text-muted-foreground">
                {entries.length} document{entries.length === 1 ? "" : "s"} ready to scan
              </p>
            </div>

            <ul className="space-y-2">
              {entries.map((entry) => (
                <li
                  key={entry.key}
                  className="flex items-center justify-between gap-3 rounded-[var(--radius-md)] bg-background/40 px-3 py-2 ring-1 ring-border"
                >
                  <span className="min-w-0 flex-1 truncate font-[family-name:var(--font-mono)] text-sm text-foreground">
                    {entry.file.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(entry.file.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(entry.key)}
                    className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                    <span className="sr-only">Remove {entry.file.name}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                onClick={runScan}
                disabled={quotaExhausted}
                className="h-11 rounded-[var(--radius-pill)] bg-signal text-signal-foreground hover:bg-signal/90 hover:shadow-[var(--shadow-signal-glow)]"
              >
                <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                Run forensic scan
              </Button>
              <Button
                variant="ghost"
                onClick={() => inputRef.current?.click()}
                disabled={quotaExhausted || entries.length >= MAX_FILES}
                className="h-11 text-muted-foreground hover:text-foreground"
              >
                Add more
              </Button>
              <Button
                variant="ghost"
                onClick={clearAll}
                className="h-11 text-muted-foreground hover:text-foreground"
              >
                <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Clear all
              </Button>
            </div>
          </div>
        ) : (
          <div className="relative flex flex-col items-center gap-4 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-signal/12 ring-1 ring-signal/25">
              <FileUp className="h-7 w-7 text-signal" aria-hidden="true" />
            </div>
            <div className="space-y-1.5">
              <p className="text-lg font-semibold text-foreground font-[family-name:var(--font-heading)]">
                Drop documents to scan
              </p>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                Pay stubs, bank statements, or invoices. PDF or image, up to
                10&nbsp;MB each, {MAX_FILES} at a time. Files are analyzed in seconds
                and never stored.
              </p>
              {/* States the substance rather than pointing at it: a spatial
                  reference assumes a viewport and a reading order, and is a
                  weak cue for a screen-reader user. The full disclosure below
                  the drop zone stays on screen in every state. */}
              <p className="mx-auto max-w-md text-xs text-muted-foreground">
                Images are sent to Anthropic for AI review of the document&rsquo;s
                content.
              </p>
            </div>
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={quotaExhausted}
              className="h-11 rounded-[var(--radius-pill)] bg-signal text-signal-foreground hover:bg-signal/90 hover:shadow-[var(--shadow-signal-glow)]"
            >
              Select documents
            </Button>
          </div>
        )}
      </div>

      {/* Third-party processing disclosure. Kept outside the drop zone so it
          stays visible once a file is selected — the moment before the user
          commits their document is when this has to be readable. */}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {AI_PRIVACY_DISCLOSURE}
      </p>

      {/* WCAG 4.1.3: always-mounted live region; visibility toggles via class.
          Uses destructive token (form-error semantics), NOT fraud severity —
          a rejected upload is a system error, not a forged-document signal. */}
      <p
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className={
          error
            ? "rounded-[var(--radius-md)] bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/30"
            : "sr-only"
        }
      >
        {error || ""}
      </p>

      {/* WCAG 4.1.3: always-mounted live region for per-file batch progress.
          role="status" (implicitly polite), NOT role="alert" — routine progress
          must not interrupt what a screen reader is already announcing. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {progressAnnouncement || ""}
      </p>

      {/* WCAG 4.1.3: always-mounted live region for the quota outcome. Polite —
          it reports the result of an action the user just took, and it is a
          billing/system state, so muted-foreground rather than severity tokens. */}
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className={
          quotaNotice
            ? "rounded-[var(--radius-md)] bg-muted/40 px-3 py-2 text-sm text-muted-foreground ring-1 ring-border"
            : "sr-only"
        }
      >
        {quotaNotice || ""}
      </p>

      {quotaExhausted && (
        // Quota-exhausted is a billing/system state, NOT a fraud signal —
        // use muted-foreground, not severity tokens (suspect/fraud).
        <p className="text-sm text-muted-foreground">
          You&apos;ve used all of your free scans. Upgrade to keep analyzing documents.
        </p>
      )}
    </div>
  );
}

function ScanningState({ fileName, label }: { fileName: string; label: string }) {
  return (
    <div className="relative flex flex-col items-center gap-5 py-2 text-center">
      {/* Document mockup with the signature forensic scan-beam sweep */}
      <div className="relative h-28 w-44 overflow-hidden rounded-[var(--radius-md)] bg-graphite/60 ring-1 ring-signal/30">
        <div className="absolute inset-x-3 top-3 space-y-1.5" aria-hidden="true">
          <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/30" />
          <div className="h-1.5 w-1/2 rounded-full bg-muted-foreground/20" />
          <div className="h-1.5 w-2/3 rounded-full bg-muted-foreground/25" />
          <div className="h-1.5 w-2/5 rounded-full bg-muted-foreground/20" />
        </div>
        <div className="scan-beam absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-signal/40 to-transparent" />
      </div>
      <div className="space-y-1">
        <p
          className="font-[family-name:var(--font-mono)] text-sm text-signal"
          aria-live="polite"
        >
          {label}
        </p>
        <p className="font-[family-name:var(--font-mono)] text-xs text-muted-foreground">
          {fileName}
        </p>
      </div>

      <style jsx>{`
        .scan-beam {
          animation: scan-sweep 1.4s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }
        @keyframes scan-sweep {
          0% {
            top: -2rem;
            opacity: 0;
          }
          15% {
            opacity: 1;
          }
          85% {
            opacity: 1;
          }
          100% {
            top: 7rem;
            opacity: 0;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .scan-beam {
            animation: none;
            top: 2.5rem;
            opacity: 0.5;
          }
        }
      `}</style>
    </div>
  );
}
