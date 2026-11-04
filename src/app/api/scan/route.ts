// POST /api/scan — accept a multipart file upload, extract metadata,
// compute the forensic fraud score, persist metadata + signals (NOT the raw
// file), and return the new scan id.
//
// EVERY upload gets an AI content pass (lib/fraud/vision.ts) — images and PDFs
// alike. It ran on images only until the accuracy gate (#49) measured the
// consequence: 0 of 20 forged PDFs detected, because the metadata path never
// reads the numbers on the page. The pass is best-effort — on any failure the
// scan keeps its metadata-only result and is labelled partial.
//
// Security:
//   - Authenticated via Supabase cookie session
//   - Rate-limited (after auth) per IP — burst protection on Vercel
//   - Free-scan quota enforced via src/lib/quota.ts
//   - Sanitized filenames per nextjs.md SK "When handling file uploads"
//   - Raw documents are NEVER persisted — only file_meta + signals + score
//   - EVERY document, image or PDF, is sent to Anthropic for the content pass
//     (disclosed pre-upload via AI_PRIVACY_DISCLOSURE, which had to change with
//     it); nothing is retained by FraudShield
//   - Zod input validation; generic { error } on ZodError (OWASP A4-InfoLeakage)

import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { computeQuota, scanWindowStart } from "@/lib/quota";
import { ACCEPTED_MIME, MAX_BYTES } from "@/lib/scan-intake";
import { runFraudScan } from "@/lib/fraud/run-scan";
import { isFullAnalysis } from "@/lib/fraud/analysis-mode";
import type { FraudSignal, SubscriptionsRow } from "@/lib/types";

// sharp (image downscaling) and Buffer are Node APIs — pin the runtime rather
// than relying on the default. maxDuration covers the AI content pass, which
// budgets up to 25s of its own before falling back.
export const runtime = "nodejs";
export const maxDuration = 60;

// --- request shape ---
// doc_type is optional and constrained — we infer from filename when absent.
export const createScanSchema = z.object({
  doc_type: z
    .enum(["pay_stub", "bank_statement", "invoice"])
    .optional(),
});
// The score and quota outcome come back with the id so a multi-document upload
// can render a summary without re-fetching every row it just created.
export type CreateScanResponse = {
  id: string;
  fraud_score: number;
  counts_toward_quota: boolean;
};

export async function POST(request: Request) {
  // 1. Auth first — unauthenticated callers don't consume rate-limit budget.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Rate limit (after auth). Uses Upstash Redis in production (set
  //    UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN); in-memory fallback
  //    in dev only — counters reset on cold start.
  const ip = clientIpFromHeaders(request.headers);
  const { success } = await rateLimit(`scan:${user.id}:${ip}`, 10, 60);
  if (!success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // 3. Parse multipart form.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Server-side file validation (defense-in-depth — client also gates).
  if (file.size === 0) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  }
  if (!ACCEPTED_MIME.has(file.type) && file.type !== "") {
    return NextResponse.json(
      { error: "Unsupported file type" },
      { status: 415 },
    );
  }

  // Optional doc_type override from a form field.
  let parsedDocType: "pay_stub" | "bank_statement" | "invoice" | undefined;
  const rawDocType = form.get("doc_type");
  if (typeof rawDocType === "string" && rawDocType.length > 0) {
    const parsed = createScanSchema.safeParse({ doc_type: rawDocType });
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    parsedDocType = parsed.data.doc_type;
  }

  // 4. Quota check — enforce free-scan limit before doing any analysis.
  try {
    // Only scans that produced a verdict consume the free allowance. A partial
    // image analysis returns EXIF evidence but no fraud score, and charging a
    // free scan for a non-answer penalises exactly the users who photograph
    // documents instead of exporting PDFs. See 005_scans_counts_toward_quota.sql.
    // Subscription is read FIRST because it carries the billing anchor that
    // decides which scans count. Pro is sold as "200 document scans / month";
    // counting all-time gave a subscriber 200 scans EVER, so month two was paid
    // for and empty. See 007_subscription_period.sql.
    // NO STATUS FILTER. This used to select only `status = "active"`, which was
    // right while the row mattered solely as proof of a subscription. It stopped
    // being right the moment scans could be bought outright: a pack buyer's
    // status is "inactive", so the filter hid their row, computeQuota saw null,
    // and the scans they had just paid for did not exist. They would have been
    // charged and given nothing.
    //
    // The row is per-user BILLING STATE, not proof of a plan. Reading it
    // unconditionally and letting computeQuota decide is what keeps those two
    // ideas separate.
    //
    // stripe_subscription_id and current_period_end are selected because
    // computeQuota's "is this user paid?" rule reads them: an active row with no
    // Stripe subscription is a COMPED grant and expires at its period end. A
    // missing current_period_end reads as "no end date", i.e. a lifetime grant,
    // so a shortened select here would hand out perpetual Pro quota silently.
    const { data: sub } = await supabase
      .from("subscriptions")
      .select(
        "status, scan_quota, scan_credits, current_period_start, stripe_subscription_id, current_period_end",
      )
      .eq("user_id", user.id)
      .maybeSingle();

    let scanQuery = supabase
      .from("scans")
      .select("id", { count: "exact", head: true })
      .eq("counts_toward_quota", true);

    // Paid plans count within the current monthly window. A NULL window means
    // free tier or a comped lifetime grant, where all-time counting is
    // correct: the free card sells "1 document scan, total", not one per
    // month.
    //
    // GATED ON hasProAccess inside scanWindowStart -- the same predicate
    // computeQuota uses below -- so the window and the allowance cannot
    // disagree about who is paid. They did disagree: the gate read status
    // directly, and an expired comp keeps status "active" for ever, so the
    // comp was handed the FREE allowance and a MONTHLY window at once. Since
    // nothing decrements scan_credits, rolling the window forward re-granted
    // the free scan and the whole purchased pack every month.
    //
    // The gate also still does its original job. The row above is read
    // regardless of status, and a CANCELLED subscriber keeps their old
    // current_period_start while currentPeriodStart() rolls any anchor
    // forward to the present -- so without it, someone who cancelled and
    // later bought a single pack would have usage counted from this month
    // only and would receive everything again monthly.
    //
    // The rule lives in lib/quota.ts rather than here so the dashboard meter
    // reads quota the same way this endpoint enforces it.

    // ONE CLOCK FOR THE WHOLE DECISION. The window picked here and the
    // allowance computed below are both derived from hasProAccess, and the
    // awaited count query sits between them -- tens to hundreds of
    // milliseconds, not a hair. Reading the clock twice meant a comp whose
    // current_period_end fell inside that gap was judged Pro by the first
    // read and expired by the second: the MONTHLY window handed the FREE
    // allowance, which is the exact disagreement this gate exists to
    // prevent. QuotaInput.now exists for this.
    const now = new Date();

    const windowStart = scanWindowStart(
      sub as Pick<
        SubscriptionsRow,
        | "status"
        | "current_period_start"
        | "stripe_subscription_id"
        | "current_period_end"
      > | null,
      now,
    );
    if (windowStart) {
      scanQuery = scanQuery.gte("created_at", windowStart.toISOString());
    }

    const { count } = await scanQuery;

    const quota = computeQuota({
      scans_used: count ?? 0,
      subscription: sub as Pick<
        SubscriptionsRow,
        | "status"
        | "scan_quota"
        | "scan_credits"
        | "stripe_subscription_id"
        | "current_period_end"
      > | null,
      now,
    });

    if (!quota.allowed) {
      return NextResponse.json(
        { error: "Free-scan quota exhausted — upgrade to keep scanning." },
        { status: 402 },
      );
    }
  } catch (e) {
    console.error("[scan] quota check error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  // 5. Sanitize filename, build metadata, score in memory, and run the AI
  //    content pass. Raw file bytes are NEVER persisted — only the derived
  //    metadata + signals + score.
  //
  //    The pipeline itself lives in lib/fraud/run-scan.ts so the anonymous
  //    free-scan surface performs the IDENTICAL analysis. Two transcriptions
  //    of it is how two surfaces start reporting different scores for the same
  //    document.
  const buf = Buffer.from(await file.arrayBuffer());
  const { score, signals, metadata, vision, docType } = await runFraudScan({
    buf,
    filename: file.name,
    // Raw, including the empty string this route lets through validation.
    mime: file.type,
    // Undefined when the client sent no doc_type — runFraudScan then infers it
    // from the sanitized filename, preserving this route's precedence.
    docType: parsedDocType,
  });

  // Strip the raw file reference — buf goes out of scope and is GC'd.
  const fileMetaForDb = metadata;
  const signalsForDb: FraudSignal[] = signals;

  // 6. Persist the scan row. RLS enforces user_id = auth.uid() on INSERT.
  try {
    const { data, error } = await supabase
      .from("scans")
      .insert({
        user_id: user.id,
        doc_type: docType,
        fraud_score: score,
        signals: signalsForDb,
        file_meta: fileMetaForDb,
        // A scan spends a free scan only when it produced a verdict. Written
        // here rather than derived on read so the decision is visible in the
        // data and the quota check stays a plain indexed count.
        counts_toward_quota: isFullAnalysis(fileMetaForDb),
        // WHAT THIS SCAN COST, as the API reported it. Spread rather than set
        // to null: a scan that never reached the model (no key, undecodable
        // upload) leaves these NULL, which reads as "not measured". Writing 0
        // would be a measurement meaning "billed nothing", which never happens,
        // and would drag every later average toward zero.
        //
        // Recorded for inconclusive and refused scans too. Those were billed
        // like any other request, and leaving them out would under-report spend
        // by exactly the scans that went wrong.
        ...(vision.usage
          ? {
              input_tokens: vision.usage.input_tokens,
              output_tokens: vision.usage.output_tokens,
              model: vision.usage.model,
            }
          : {}),
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[scan] insert error:", error);
      const detail =
        process.env.NODE_ENV === "production"
          ? undefined
          : error?.message || "No row returned from the scan insert";
      return NextResponse.json(
        { error: "Failed to record scan", ...(detail ? { detail } : {}) },
        { status: 500 },
      );
    }

    const response: CreateScanResponse = {
      id: data.id as string,
      fraud_score: score,
      counts_toward_quota: isFullAnalysis(fileMetaForDb),
    };
    return NextResponse.json(response, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    console.error("[scan] unhandled error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
