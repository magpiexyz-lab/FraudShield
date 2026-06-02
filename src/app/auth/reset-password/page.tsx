"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AuthShell } from "../../login/auth-shell";

const PASSWORD_MIN = 8;

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const tooShort = password.length > 0 && password.length < PASSWORD_MIN;

  async function handleReset(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (password.length < PASSWORD_MIN) {
      setError(`Password must be at least ${PASSWORD_MIN} characters`);
      return;
    }
    setLoading(true);
    setError("");
    const supabase = createClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    router.push("/dashboard");
  }

  return (
    <AuthShell
      eyebrow="Reset password"
      heading="Set a new password"
      subheading="Choose a new password to finish recovering your evidence lab — eight characters or more, something only you would guess."
    >
      <form onSubmit={handleReset} className="space-y-5" noValidate>
        <div className="space-y-2">
          <Label htmlFor="password" className="text-sm font-medium text-foreground">
            New password
          </Label>
          <Input
            id="password"
            type="password"
            placeholder="At least 8 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN}
            autoComplete="new-password"
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
          aria-atomic="true"
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
          aria-label={loading ? "Updating password" : undefined}
          className="h-11 w-full rounded-[var(--radius-pill)] bg-[var(--signal)] font-medium text-[var(--signal-foreground)] transition-all duration-200 hover:bg-[var(--signal)]/90 hover:shadow-[var(--shadow-signal-glow)] disabled:opacity-70"
        >
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
              />
              Updating…
            </span>
          ) : (
            "Set new password"
          )}
        </Button>

        <p className="text-center text-sm text-muted-foreground">
          Remembered it after all?{" "}
          <Link
            href="/login"
            className="font-medium text-[var(--signal)] underline-offset-4 hover:underline"
          >
            Back to log in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
