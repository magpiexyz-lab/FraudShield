// Health check endpoint — Vercel preview-smoke + uptime monitor target.
// Returns ONLY { status: "ok" | "degraded" } — never expose subsystem keys,
// env-var presence, or raw error messages (OWASP A4-InfoLeakage).
// Diagnostic detail is logged server-side via console.error.

import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { POSTHOG_HOST, POSTHOG_KEY } from "@/lib/analytics-server";

export async function GET() {
  const checks: Record<string, "ok" | "degraded" | "error"> = {};

  // --- database connectivity (critical) ---
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.from("scans").select("id").limit(1);
    if (error) {
      console.error("Health check database error:", error.message);
      checks.database = "error";
    } else {
      checks.database = "ok";
    }
  } catch (e) {
    console.error("Health check database error:", e);
    checks.database = "error";
  }

  // --- auth service (critical) ---
  try {
    const supabase = await createServerSupabaseClient();
    // getUser() with no session returns { data: { user: null }, error: ... }
    // We only want to know the auth service is REACHABLE, not whether the
    // caller is authenticated. Any non-throw is "ok".
    await supabase.auth.getUser();
    checks.auth = "ok";
  } catch (e) {
    console.error("Health check auth error:", e);
    checks.auth = "error";
  }

  // --- analytics reachability (non-critical, 3s timeout) ---
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(POSTHOG_HOST + "/decide?v=3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: POSTHOG_KEY, distinct_id: "healthcheck" }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    checks.analytics = res.ok ? "ok" : "error";
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      checks.analytics = "degraded";
    } else {
      console.error("Health check analytics error:", e);
      checks.analytics = "error";
    }
  }

  // --- payment config (non-critical) ---
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
    if (stripeKey.startsWith("sk_")) {
      checks.payment = "ok";
    } else {
      console.error("Health check payment error: STRIPE_SECRET_KEY missing or malformed");
      checks.payment = "error";
    }
  } catch (e) {
    console.error("Health check payment error:", e);
    checks.payment = "error";
  }

  const critical = Object.entries(checks).filter(([k]) => ["database", "auth"].includes(k));
  const hasCriticalFailure = critical.some(([, v]) => v === "error");

  return NextResponse.json(
    { status: hasCriticalFailure ? "degraded" : "ok" },
    { status: hasCriticalFailure ? 503 : 200 },
  );
}
