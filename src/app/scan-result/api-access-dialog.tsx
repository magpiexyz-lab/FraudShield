"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trackApiInterestClick } from "@/lib/events";
import { VOLUME_BANDS, VOLUME_BAND_LABELS } from "@/lib/volume-bands";

type Status = "idle" | "submitting" | "success" | "error";

// b-05 API fake door. Opening the dialog fires api_interest_click (the integration-
// demand signal), then captures a waitlist email via POST /api/waitlist. The route is
// built later by scaffold-wire — this just fetches it. On failure we still treat the
// click as a recorded signal (the analytics event already fired on open).
export function ApiAccessDialog({ docType }: { docType: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [volume, setVolume] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const firedRef = useRef(false);
  const successRef = useRef<HTMLDivElement>(null);

  // Fire the demand signal exactly once, the first time the dialog opens.
  useEffect(() => {
    if (open && !firedRef.current) {
      firedRef.current = true;
      trackApiInterestClick({ doc_type: docType });
    }
  }, [open, docType]);

  useEffect(() => {
    if (status === "success") successRef.current?.focus();
  }, [status]);

  async function onSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMessage("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // source stays "scan-result-api-access" so these rows remain
        // separable from the pro-upgrade waitlist, which posts email alone.
        body: JSON.stringify({
          email,
          source: "scan-result-api-access",
          company,
          role,
          monthly_volume: volume,
        }),
      });
      if (!res.ok) throw new Error("request failed");
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMessage("Could not reach the waitlist. Please try again.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={(props) => (
          <Button
            type="button"
            variant="outline"
            {...props}
            className="h-11 rounded-pill border-signal/40 text-foreground hover:bg-signal/10 hover:border-signal"
          >
            Get API access
          </Button>
        )}
      />
      <DialogContent className="bg-card">
        <DialogHeader>
          <DialogTitle className="font-heading">
            Integrate FraudShield into your stack
          </DialogTitle>
          <DialogDescription>
            Score documents programmatically from your underwriting or onboarding
            flow. Join the API waitlist and we&apos;ll reach out with early access.
          </DialogDescription>
        </DialogHeader>

        {status !== "success" ? (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="api-waitlist-company">Company</Label>
              <Input
                id="api-waitlist-company"
                type="text"
                required
                maxLength={120}
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Northfield Lending"
                autoComplete="organization"
                className="h-11 text-base"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="api-waitlist-role">Your role</Label>
              <Input
                id="api-waitlist-role"
                type="text"
                required
                maxLength={120}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="Head of underwriting"
                autoComplete="organization-title"
                className="h-11 text-base"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="api-waitlist-volume">Documents per month</Label>
              {/* A coarse band, not a number: nobody knows their exact volume,
                  and a band separates a 50-document reviewer from a 5,000 well
                  enough to route the conversation. Same scale as the
                  enterprise-lead form, from one shared definition. */}
              <select
                id="api-waitlist-volume"
                required
                value={volume}
                onChange={(e) => setVolume(e.target.value)}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                <option value="" disabled>
                  Select a range
                </option>
                {VOLUME_BANDS.map((band) => (
                  <option key={band} value={band}>
                    {VOLUME_BAND_LABELS[band]}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="api-waitlist-email">Work email</Label>
              <Input
                id="api-waitlist-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                autoComplete="email"
                className="h-11 text-base"
              />
            </div>

            {/* Unconditionally-mounted live region; text toggles, container stays. */}
            <p
              role="alert"
              aria-live="assertive"
              aria-atomic="true"
              className={
                status === "error"
                  ? "min-h-[1.25rem] text-xs text-fraud"
                  : "sr-only"
              }
            >
              {status === "error" ? errorMessage : ""}
            </p>

            <Button
              type="submit"
              disabled={status === "submitting"}
              aria-label={status === "submitting" ? "Joining the waitlist" : undefined}
              className="h-11 w-full rounded-pill bg-signal text-signal-foreground hover:bg-signal/90"
            >
              {status === "submitting" ? "Joining…" : "Join the API waitlist"}
            </Button>
          </form>
        ) : (
          <div
            ref={successRef}
            tabIndex={-1}
            aria-live="polite"
            className="space-y-2 rounded-lg bg-signal/10 p-4 ring-1 ring-signal/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            <h3 className="font-heading text-base font-semibold text-foreground">
              You&apos;re on the list.
            </h3>
            <p className="text-sm text-muted-foreground">
              We&apos;ll email <span className="font-mono text-foreground">{email}</span> when
              the FraudShield API opens for early access.
            </p>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              className="h-11 px-3"
            >
              Back to my scan
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
