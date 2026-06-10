"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { trackFeedbackSubmitted } from "@/lib/events";

const STORAGE_KEY = "fraudshield_feedback_shown_v1";

type Source = "google" | "social" | "friend" | "other" | "";

export function FeedbackWidget({
  show,
  activationAction,
  delayMs = 1200,
}: {
  show: boolean;
  activationAction: string;
  delayMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<Source>("");
  const [feedback, setFeedback] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!show) return;
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem(STORAGE_KEY)) return;
    const t = window.setTimeout(() => setOpen(true), delayMs);
    return () => window.clearTimeout(t);
  }, [show, delayMs]);

  function markShown() {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(Date.now()));
    }
  }

  function handleClose() {
    markShown();
    setOpen(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    trackFeedbackSubmitted({
      source: source || undefined,
      feedback: feedback.trim() || undefined,
      activation_action: activationAction,
    });
    markShown();
    setSubmitted(true);
    window.setTimeout(() => setOpen(false), 1400);
  }

  const selectClass =
    "h-10 w-full rounded-[var(--radius-md)] border border-border bg-background px-3 text-sm text-foreground transition-colors focus:border-[var(--signal)] focus:outline-none focus:ring-2 focus:ring-[var(--signal)]/30";
  const textareaClass =
    "min-h-[88px] w-full rounded-[var(--radius-md)] border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors focus:border-[var(--signal)] focus:outline-none focus:ring-2 focus:ring-[var(--signal)]/30";

  return (
    <Dialog
      open={open}
      onOpenChange={(v: boolean) => {
        if (!v) handleClose();
      }}
    >
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Quick question — how did you find FraudShield?</DialogTitle>
          <DialogDescription>
            30 seconds. Helps us reach more teams like yours. Optional.
          </DialogDescription>
        </DialogHeader>

        {submitted ? (
          <p
            role="status"
            className="rounded-[var(--radius-md)] bg-[var(--signal)]/10 px-3 py-3 text-sm text-[var(--signal)] ring-1 ring-[var(--signal)]/25"
          >
            Thanks — noted.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="fw-source" className="text-sm font-medium text-foreground">
                How did you find us?
              </Label>
              <select
                id="fw-source"
                value={source}
                onChange={(e) => setSource(e.target.value as Source)}
                className={selectClass}
              >
                <option value="">Select…</option>
                <option value="google">Google Search</option>
                <option value="social">Social Media</option>
                <option value="friend">Friend / Referral</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="fw-feedback" className="text-sm font-medium text-foreground">
                Any feedback? <span className="text-muted-foreground">(optional)</span>
              </Label>
              <textarea
                id="fw-feedback"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="What worked, what didn't, what you wish it did…"
                maxLength={500}
                className={textareaClass}
              />
            </div>

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={handleClose}
                className="text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Skip
              </button>
              <Button
                type="submit"
                className="h-10 rounded-[var(--radius-pill)] bg-[var(--signal)] px-5 font-medium text-[var(--signal-foreground)] hover:bg-[var(--signal)]/90"
              >
                Send
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
