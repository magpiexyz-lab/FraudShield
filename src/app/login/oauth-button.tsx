"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase";
import { trackSignupStart } from "@/lib/events";
import {
  buildOAuthRedirectTo,
  readAttribution,
  writeAttributionCookie,
} from "@/lib/attribution";
import { Button } from "@/components/ui/button";

/**
 * "Continue with Google" — shared by /login and /signup (colocated here, the
 * canonical owner, exactly like AuthShell).
 *
 * Google OAuth is configured in the Supabase dashboard (provider enabled,
 * client id/secret stored, redirect URLs allow-listed), so no credentials
 * appear in code — Supabase owns the whole exchange and PKCE covers CSRF.
 *
 * The attribution work here is the non-obvious part: the redirect to Google
 * tears down the page, and `/auth/callback` fires `signup_complete` on the
 * SERVER where sessionStorage does not exist. So the click ids are read on the
 * client and relayed two ways — on the `redirectTo` URL and in a short-lived
 * cookie — before we hand control to Supabase. See src/lib/attribution.ts.
 */
export function GoogleOAuthButton({
  next = "/dashboard",
  label = "Continue with Google",
}: {
  next?: string;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleOAuthLogin() {
    setLoading(true);
    setError("");

    // Fire BEFORE the redirect — it leaves the page and anything queued after
    // this point never sends. Same event for login and signup: at click time we
    // cannot know whether Google will hand back a new or returning user.
    trackSignupStart({ method: "google" });

    // sessionStorage access itself can throw in private mode / sandboxed frames.
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      storage = null;
    }
    const attribution = readAttribution(window.location.search, storage);

    // Fallback channel: survives even if the Supabase redirect allow-list
    // strips unknown query params off redirectTo.
    writeAttributionCookie(attribution);

    const supabase = createClient();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: buildOAuthRedirectTo(window.location.origin, next, attribution),
      },
    });

    if (oauthError) {
      setError(oauthError.message);
      setLoading(false);
    }
    // No error → the browser is navigating to Google; keep the button disabled
    // so a second click cannot start a competing exchange.
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <div aria-hidden="true" className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-background px-2 text-muted-foreground">Or continue with</span>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        onClick={handleOAuthLogin}
        disabled={loading}
        aria-label={loading ? "Redirecting to Google" : undefined}
        className="h-11 w-full rounded-[var(--radius-pill)] font-medium"
      >
        {loading ? (
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            Redirecting…
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <GoogleMark />
            {label}
          </span>
        )}
      </Button>

      <p
        role="alert"
        aria-live="assertive"
        className={
          error
            ? "rounded-[var(--radius-md)] bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20"
            : "sr-only"
        }
      >
        {error || ""}
      </p>
    </div>
  );
}

/** Google's four-colour mark. Inline so the button needs no network request. */
function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="h-4 w-4">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.41 5.41 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
