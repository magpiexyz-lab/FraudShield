"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";
import { AbandonReasonCard, abandonPromptAnswered } from "@/app/pricing/abandon-reason-prompt";

/**
 * Asks the abandonment question of someone who closed the Stripe tab.
 *
 * WHY A SECOND SURFACE. The prompt on /pricing?checkout=cancelled only catches
 * people who press Stripe's back button. Everyone who simply closes the tab
 * never returns to a URL we control, and they are the larger group -- four
 * live Checkout Sessions expired in the first days of the campaign without a
 * single one of them landing back on a page that could ask.
 *
 * Stripe tells us about those roughly a day later, via
 * checkout.session.expired. By then the person is long gone, so the webhook
 * only sets a flag; this is where the flag is finally spent, the next time
 * they sign in.
 *
 * READS THE FLAG OFF THE SESSION, not the database. The webhook writes it to
 * app_metadata, which rides along in the user's JWT, so deciding whether to
 * ask costs nothing. It also cannot be written by the user's own session, so
 * the prompt cannot be re-triggered from the browser.
 *
 * The flag is deliberately not cleared. Clearing it would need a service-role
 * write, and therefore an API route whose only job is to dismiss a survey --
 * more surface than the thing is worth. Whether the question has been answered
 * is tracked exactly as it is on the pricing page, in localStorage, so the two
 * surfaces never both ask.
 */
export function AbandonFollowup() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      // Already answered, on either surface. Nothing to ask.
      if (abandonPromptAnswered()) return;

      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getUser();
        const flagged = Boolean(
          (data?.user?.app_metadata as Record<string, unknown> | undefined)?.[
            "checkout_abandoned_at"
          ],
        );
        if (!cancelled && flagged) setVisible(true);
      } catch {
        // No session, demo client, or a network failure. Not asking is the
        // correct outcome — this is a measurement, never something to retry.
      }
    }

    check();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="mb-8">
      <AbandonReasonCard />
    </div>
  );
}
