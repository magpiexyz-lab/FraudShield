"use client";

import { useEffect } from "react";
import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase";
import { getDistinctId, identify, reset } from "@/lib/analytics";
import { shouldIdentify } from "@/lib/analytics-identity";

/**
 * Keeps the browser's PostHog person in step with the signed-in Supabase user.
 *
 * See src/lib/analytics-identity.ts for the bug this closes: email-confirmation
 * and Google signups never ran client-side identify(), so their browser events
 * and their server events landed on two different PostHog people.
 *
 * MOUNTED IN THE ROOT LAYOUT, deliberately, rather than on the authenticated
 * pages. The gap was caused by identity being the responsibility of individual
 * pages, and two routes into a session not passing through any of them. A
 * component that runs everywhere cannot be bypassed by a new auth route added
 * later.
 *
 * THE THREE EXISTING identify() CALLS STAY. login, signup and reset-password
 * each call it before an immediately-following track() call, and leaving them
 * keeps that ordering explicit at the call site. They are now redundant rather
 * than load-bearing -- this component would catch all three -- and are harmless
 * because shouldIdentify() makes a repeat identify a no-op.
 */
export function AnalyticsIdentity() {
  useEffect(() => {
    const supabase = createClient();

    function sync(session: Session | null) {
      const userId = session?.user?.id;
      if (shouldIdentify(getDistinctId(), userId)) {
        identify(userId as string);
      }
    }

    // The session that already exists on this page load. onAuthStateChange
    // below also emits INITIAL_SESSION, but only in supabase-js v2.7+, and a
    // missed identify is a permanently split person -- so this does not rely
    // on it. A redundant call costs nothing: shouldIdentify() returns false
    // the second time.
    supabase.auth
      .getSession()
      // Explicitly annotated: createClient() can return the demo proxy, which
      // leaves this resolution untyped. Same reason nav-bar.tsx annotates its
      // onAuthStateChange callback.
      .then(({ data }: { data: { session: Session | null } }) =>
        sync(data.session),
      )
      .catch(() => {
        // Network failure or demo client. Nothing to identify; the auth
        // listener below still fires if a session appears later.
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (event: string, session: Session | null) => {
        // RESET ON SIGN-OUT, and this half matters on its own. Without it the
        // browser keeps the previous user's distinct id, so the next person to
        // sign up on a shared machine has their signup_start and paywall_shown
        // attributed to whoever used it last -- and the two accounts merge into
        // one PostHog person. reset() returns the browser to a fresh anonymous
        // id. Nothing called it before this component existed.
        if (event === "SIGNED_OUT") {
          reset();
          return;
        }
        sync(session);
      },
    );

    return () => subscription.unsubscribe();
  }, []);

  return null;
}
