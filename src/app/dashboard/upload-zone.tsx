"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { useRouter } from "next/navigation";
import { FileUp, FileText, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

type UploadStatus = "idle" | "ready" | "scanning" | "error";

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

export function UploadZone({ quotaRemaining }: { quotaRemaining: number }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progressLabel, setProgressLabel] = useState("");

  const quotaExhausted = quotaRemaining <= 0;

  const accept = useCallback(
    (next: File | null) => {
      if (!next) return;
      const problem = validate(next);
      if (problem) {
        setError(problem);
        setStatus("error");
        setFile(null);
        return;
      }
      setError("");
      setFile(next);
      setStatus("ready");
    },
    [],
  );

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    accept(e.target.files?.[0] ?? null);
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (quotaExhausted || status === "scanning") return;
    accept(e.dataTransfer.files?.[0] ?? null);
  }

  function clearFile() {
    setFile(null);
    setStatus("idle");
    setError("");
    if (inputRef.current) inputRef.current.value = "";
  }

  // Forensic-scan progress choreography while the request is in flight.
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

  async function runScan() {
    if (!file || quotaExhausted) return;
    setStatus("scanning");
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/scan", { method: "POST", body });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(payload?.error ?? "We couldn't analyze that document. Please try again.");
      }
      const result = (await res.json()) as { id?: string };
      if (!result.id) {
        throw new Error("The scan completed but returned no result id.");
      }
      // Navigate to the forensic result. activate fires there, not here.
      // scan-result is a single page that reads ?id=<scanId> via
      // useSearchParams() — see src/app/scan-result/page.tsx (no [id]
      // dynamic segment exists, so a path-style URL would 404).
      router.push(`/scan-result?id=${encodeURIComponent(result.id)}`);
    } catch (err) {
      setStatus("error");
      setError(
        err instanceof Error
          ? err.message
          : "We couldn't analyze that document. Please try again.",
      );
    }
  }

  const scanning = status === "scanning";

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_EXT}
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
          "relative overflow-hidden rounded-[var(--radius-lg)] p-8 transition-all duration-200",
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
          <ScanningState fileName={file?.name ?? "document"} label={progressLabel} />
        ) : file ? (
          <div className="relative flex flex-col items-center gap-4 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-signal/15 ring-1 ring-signal/30">
              <FileText className="h-6 w-6 text-signal" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <p className="font-[family-name:var(--font-mono)] text-sm text-foreground">
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
            </div>
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
                onClick={clearFile}
                className="h-11 text-muted-foreground hover:text-foreground"
              >
                <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Choose another
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
                Drop a document to scan
              </p>
              <p className="mx-auto max-w-md text-sm text-muted-foreground">
                Pay stub, bank statement, or invoice. PDF or image, up to 10&nbsp;MB.
                Files are analyzed in seconds and never stored.
              </p>
            </div>
            <Button
              onClick={() => inputRef.current?.click()}
              disabled={quotaExhausted}
              className="h-11 rounded-[var(--radius-pill)] bg-signal text-signal-foreground hover:bg-signal/90 hover:shadow-[var(--shadow-signal-glow)]"
            >
              Select a document
            </Button>
          </div>
        )}
      </div>

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
