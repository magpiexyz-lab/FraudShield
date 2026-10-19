"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  trackCheckoutAbandonReason,
  type CheckoutAbandonReason,
} from "@/lib/events";

/**
 * One question for someone who opened Stripe Checkout and came back without
 * paying.
 *
 * WHY IT EXISTS. We could see who reached Checkout and who paid, and nothing
 * at all about the gap between — the single largest and darkest drop in the
 * funnel. subscription_canceled explains why a PAYING customer left; this
 * explains why someone never became one. At $60/month unchanged, it separates
 * a no-pay that is about price from one about trust or process, which are
 * three completely different problems with three different fixes.
 *
 * SHOWN ONLY ON RETURN FROM CHECKOUT. Stripe's back button already lands on
 * /pricing?checkout=cancelled, so the trigger is a fact about what the person
 * just did, not a guess. Someone browsing /pricing normally never sees it.
 *
 * ONE QUESTION, AND SKIPPABLE. They have just declined to spend $60; a survey
 * is an imposition at that moment. Four fixed choices and an optional line is
 * the most that can be asked without the prompt itself becoming a reason not
 * to come back.
 */

const REASONS: ReadonlyArray<{ value: CheckoutAbandonReason; label: string }> = [
  { value: "price", label: "The price" },
  { value: "unsure_fit", label: "Not sure it would work for me" },
  { value: "need_team_invoice", label: "I need a team/invoice option" },
  { value: "just_looking", label: "Just looking" },
];

const MAX_TEXT = 300;

/**
 * Per-browser record that this person has already been asked.
 *
 * localStorage rather than a column: the prompt is a one-off measurement, and
 * a database write would mean a migration and a round trip to decide whether
 * to render a small card. The cost of being wrong is that someone on a second
 * device is asked twice, which is a far smaller problem than asking the same
 * person on every single return.
 *
 * (The expired-session half of this feature DOES need a durable flag, because
 * the prompt has to survive until their next sign-in. That is its own change.)
 */
const SEEN_KEY = "fs_abandon_prompt_seen";

function alreadyAsked(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    // Private mode or blocked storage. Better to ask than to crash.
    return false;
  }
}

function markAsked() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Nothing to do — the answer still sends.
  }
}

export function AbandonReasonPrompt() {
  const searchParams = useSearchParams();
  const cancelled = searchParams.get("checkout") === "cancelled";
  const [visible, setVisible] = useState(false);
  const [choice, setChoice] = useState<CheckoutAbandonReason | null>(null);
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);

  // localStorage is read in an effect, never during render: it does not exist
  // on the server, and reading it during render makes the markup differ
  // between server and client.
  useEffect(() => {
    if (cancelled && !alreadyAsked()) setVisible(true);
  }, [cancelled]);

  if (!visible) return null;

  function send(reason: CheckoutAbandonReason) {
    const trimmed = text.trim().slice(0, MAX_TEXT);
    trackCheckoutAbandonReason({
      reason,
      ...(trimmed ? { reason_text: trimmed } : {}),
    });
    markAsked();
    setDone(true);
  }

  if (done) {
    return (
      <div
        role="status"
        className="rounded-xl border border-border bg-card/60 p-5 text-center text-sm text-muted-foreground"
      >
        Thanks — that helps.
      </div>
    );
  }

  return (
    <section
      aria-labelledby="abandon-prompt-heading"
      className="rounded-xl border border-border bg-card/60 p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <h2
          id="abandon-prompt-heading"
          className="font-heading text-base font-semibold text-foreground"
        >
          What stopped you?
        </h2>
        {/* A dismissal is an answer, not an absence — see the note in
            events.ts on why "skipped" is recorded rather than swallowed. */}
        <button
          type="button"
          onClick={() => send("skipped")}
          className="shrink-0 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Skip
        </button>
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        One question, and it helps us more than you&rsquo;d think.
      </p>

      <div className="mt-4 flex flex-col gap-2">
        {REASONS.map((reason) => (
          <button
            key={reason.value}
            type="button"
            onClick={() => setChoice(reason.value)}
            aria-pressed={choice === reason.value}
            className={cn(
              "rounded-lg border px-4 py-2.5 text-left text-sm transition-colors",
              choice === reason.value
                ? "border-signal bg-signal/10 text-foreground"
                : "border-border text-muted-foreground hover:border-signal/50 hover:text-foreground",
            )}
          >
            {reason.label}
          </button>
        ))}
      </div>

      <label htmlFor="abandon-reason-text" className="sr-only">
        Anything else? (optional)
      </label>
      <Input
        id="abandon-reason-text"
        value={text}
        maxLength={MAX_TEXT}
        onChange={(e) => setText(e.target.value)}
        placeholder="Anything else? (optional)"
        className="mt-3"
      />

      <Button
        type="button"
        disabled={choice === null}
        onClick={() => choice && send(choice)}
        className="mt-3 h-11 w-full rounded-full"
      >
        Send
      </Button>
    </section>
  );
}
