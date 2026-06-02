"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "./auth-shell";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const confirmed = searchParams.get("confirmed") === "true";
  const authError = searchParams.get("error") === "auth";
  // Honor the proxy redirect target; default into the workspace.
  const rawNext = searchParams.get("next");
  const next =
    rawNext && rawNext.startsWith("/") && !rawNext.startsWith("//")
      ? rawNext
      : "/dashboard";

  async function handleLogin(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push(next);
  }

  async function handleForgotPassword(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset-password`,
    });
    setLoading(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setForgotSent(true);
  }

  // shared input + pill-CTA styling, matching the signup surface
  const inputClass = "h-11";
  const ctaClass =
    "h-11 w-full rounded-[var(--radius-pill)] bg-[var(--signal)] font-medium text-[var(--signal-foreground)] transition-all duration-200 hover:bg-[var(--signal)]/90 hover:shadow-[var(--shadow-signal-glow)] disabled:opacity-70";

  return (
    <div className="space-y-5">
      {/* status banners from /auth/callback */}
      {confirmed && (
        <p
          role="status"
          className="rounded-[var(--radius-md)] bg-[var(--signal)]/10 px-3 py-2 text-sm text-[var(--signal)] ring-1 ring-[var(--signal)]/25"
        >
          Email confirmed — log in to open your workspace.
        </p>
      )}
      {authError && (
        <p
          role="alert"
          className="rounded-[var(--radius-md)] bg-destructive/10 px-3 py-2 text-sm text-destructive ring-1 ring-destructive/20"
        >
          Authentication failed. Please log in again.
        </p>
      )}

      {forgotMode ? (
        forgotSent ? (
          <div
            role="status"
            aria-live="polite"
            className="space-y-5 rounded-[var(--radius-lg)] bg-[oklch(0.305_0.040_222)]/40 p-6 ring-1 ring-[var(--signal)]/30"
          >
            <p className="font-medium text-foreground">Check your email</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              We sent a reset link to <span className="font-mono">{email}</span>.
              Follow it to set a new password.
            </p>
            <button
              type="button"
              className="text-sm font-medium text-[var(--signal)] underline-offset-4 hover:underline"
              onClick={() => {
                setForgotMode(false);
                setForgotSent(false);
              }}
            >
              Back to log in
            </button>
          </div>
        ) : (
          <form onSubmit={handleForgotPassword} className="space-y-5" noValidate>
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium text-foreground">
                Email
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className={inputClass}
              />
              <p className="text-xs text-muted-foreground">
                We&rsquo;ll send a secure link to reset your password.
              </p>
            </div>

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

            <Button
              type="submit"
              disabled={loading}
              aria-label={loading ? "Sending reset link" : undefined}
              className={ctaClass}
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                  />
                  Sending…
                </span>
              ) : (
                "Send reset link"
              )}
            </Button>
            <button
              type="button"
              className="block text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => {
                setForgotMode(false);
                setError("");
              }}
            >
              Back to log in
            </button>
          </form>
        )
      ) : (
        <form onSubmit={handleLogin} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-medium text-foreground">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className={inputClass}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password" className="text-sm font-medium text-foreground">
                Password
              </Label>
              <button
                type="button"
                className="text-xs font-medium text-[var(--signal)] underline-offset-4 hover:underline"
                onClick={() => {
                  setForgotMode(true);
                  setError("");
                }}
              >
                Forgot password?
              </button>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="Your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={`${inputClass} font-mono`}
            />
          </div>

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

          <Button
            type="submit"
            disabled={loading}
            aria-label={loading ? "Logging in" : undefined}
            className={ctaClass}
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
                Logging in…
              </span>
            ) : (
              "Log in to your workspace"
            )}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Don&rsquo;t have an account?{" "}
            <Link
              href="/signup"
              className="font-medium text-[var(--signal)] underline-offset-4 hover:underline"
            >
              Sign up
            </Link>
          </p>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <AuthShell
        eyebrow="Welcome back"
        heading="Log in to FraudShield"
        subheading="Open your evidence lab to review scan history and run a fresh forensic fraud score."
      >
        <LoginForm />
      </AuthShell>
    </Suspense>
  );
}
