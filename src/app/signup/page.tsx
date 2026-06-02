"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { trackSignupStart, trackSignupComplete } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "../login/auth-shell";

const PASSWORD_MIN = 8;

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  // Fire signup_start once when the account-creation surface mounts.
  useEffect(() => {
    trackSignupStart();
  }, []);

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN;

  async function handleSignup(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters`);
      return;
    }
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { data, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setLoading(false);
    if (authError) {
      setError(authError.message);
      return;
    }
    if (data.user?.identities?.length === 0) {
      setError("An account with this email already exists. Log in instead.");
      return;
    }
    if (!data.session) {
      setSuccess("Check your email for a confirmation link to finish setting up your account.");
      return;
    }
    // Confirmed + logged-in immediately (email confirmation disabled).
    trackSignupComplete();
    router.push("/dashboard");
  }

  return (
    <AuthShell
      eyebrow="Create your evidence lab"
      heading="Start scanning documents free"
      subheading="Spin up your FraudShield workspace and run a forensic fraud score on your first pay stub, bank statement, or invoice in seconds."
    >
      {success ? (
        <div
          role="status"
          aria-live="polite"
          className="space-y-5 rounded-[var(--radius-lg)] bg-[oklch(0.305_0.040_222)]/40 p-6 ring-1 ring-[var(--signal)]/30"
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="grid h-9 w-9 place-items-center rounded-full bg-[var(--signal)]/15 font-mono text-[var(--signal)]"
            >
              ✓
            </span>
            <p className="font-medium text-foreground">Confirm your email</p>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{success}</p>
          <p className="text-sm text-muted-foreground">
            Already confirmed?{" "}
            <Link
              href="/login"
              className="font-medium text-[var(--signal)] underline-offset-4 hover:underline"
            >
              Log in
            </Link>
          </p>
        </div>
      ) : (
        <form onSubmit={handleSignup} className="space-y-5" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email" className="text-sm font-medium text-foreground">
              Work email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="h-11"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password" className="text-sm font-medium text-foreground">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={PASSWORD_MIN}
              aria-describedby="password-hint"
              aria-invalid={tooShort}
              className="h-11 font-mono"
            />
            <p
              id="password-hint"
              className={
                tooShort
                  ? "text-xs font-medium text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {tooShort
                ? `${PASSWORD_MIN - password.length} more character${
                    PASSWORD_MIN - password.length === 1 ? "" : "s"
                  } needed`
                : "Minimum 8 characters. Use something only you would guess."}
            </p>
          </div>

          {/* WCAG 4.1.3: live region mounted unconditionally; visibility toggles. */}
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
            aria-label={loading ? "Creating your account" : undefined}
            className="h-11 w-full rounded-[var(--radius-pill)] bg-[var(--signal)] font-medium text-[var(--signal-foreground)] transition-all duration-200 hover:bg-[var(--signal)]/90 hover:shadow-[var(--shadow-signal-glow)] disabled:opacity-70"
          >
            {loading ? (
              <span className="inline-flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
                Creating account…
              </span>
            ) : (
              "Scan your first document free"
            )}
          </Button>

          <p className="text-center text-sm text-muted-foreground">
            Already have an account?{" "}
            <Link
              href="/login"
              className="font-medium text-[var(--signal)] underline-offset-4 hover:underline"
            >
              Log in
            </Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}
