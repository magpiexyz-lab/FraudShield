// POST /api/scan — accept a multipart file upload, extract metadata,
// compute the forensic fraud score, persist metadata + signals (NOT the raw
// file), and return the new scan id.
//
// Security:
//   - Authenticated via Supabase cookie session
//   - Rate-limited (after auth) per IP — burst protection on Vercel
//   - Free-scan quota enforced via src/lib/quota.ts
//   - Sanitized filenames per nextjs.md SK "When handling file uploads"
//   - Raw documents are NEVER persisted — only file_meta + signals + score
//   - Zod input validation; generic { error } on ZodError (OWASP A4-InfoLeakage)

import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase-server";
import { rateLimit, clientIpFromHeaders } from "@/lib/rate-limit";
import { computeQuota } from "@/lib/quota";
import { computeFraudScore } from "@/lib/fraud/score";
import type {
  DocumentMetadata,
  ScoringInput,
} from "@/lib/fraud/score";
import type { FraudSignal, SubscriptionsRow } from "@/lib/types";

// --- request shape ---
// doc_type is optional and constrained — we infer from filename when absent.
export const createScanSchema = z.object({
  doc_type: z
    .enum(["pay_stub", "bank_statement", "invoice"])
    .optional(),
});
export type CreateScanResponse = { id: string };

// Server-side accepted MIME + size cap (client also checks; the server is the
// authoritative gate).
const ACCEPTED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Sanitize a user-supplied filename before any string interpolation.
// Per nextjs.md SK "When handling file uploads".
function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 255);
}

// Infer doc_type from a sanitized filename when the client did not provide one.
function inferDocType(name: string): "pay_stub" | "bank_statement" | "invoice" {
  const n = name.toLowerCase();
  if (n.includes("bank") || n.includes("statement")) return "bank_statement";
  if (n.includes("invoice") || n.includes("inv-") || n.includes("inv_"))
    return "invoice";
  return "pay_stub";
}

// Best-effort PDF metadata extraction. We pull a small slice of the buffer and
// regex-match against the Info dict — this avoids pulling a heavy PDF parser
// dependency for the MVP. Anything we can't parse just stays undefined.
function extractPdfMetadata(buf: Buffer): Partial<DocumentMetadata> {
  const slice = buf.subarray(0, Math.min(buf.length, 65536)).toString("latin1");
  const meta: Partial<DocumentMetadata> = {};

  const producer = /\/Producer\s*\(([^)]+)\)/.exec(slice)?.[1];
  if (producer) meta.pdf_producer = producer.trim();

  const creator = /\/Creator\s*\(([^)]+)\)/.exec(slice)?.[1];
  if (creator) meta.pdf_creator = creator.trim();

  const created = /\/CreationDate\s*\(D:?([0-9]{14})/.exec(slice)?.[1];
  if (created) {
    const y = created.slice(0, 4);
    const mo = created.slice(4, 6);
    const d = created.slice(6, 8);
    const h = created.slice(8, 10);
    const mi = created.slice(10, 12);
    const s = created.slice(12, 14);
    meta.pdf_created = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }

  const modified = /\/ModDate\s*\(D:?([0-9]{14})/.exec(slice)?.[1];
  if (modified) {
    const y = modified.slice(0, 4);
    const mo = modified.slice(4, 6);
    const d = modified.slice(6, 8);
    const h = modified.slice(8, 10);
    const mi = modified.slice(10, 12);
    const s = modified.slice(12, 14);
    meta.pdf_modified = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }

  const pageCount = (slice.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  if (pageCount > 0) meta.page_count = pageCount;

  return meta;
}

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
    const { count } = await supabase
      .from("scans")
      .select("id", { count: "exact", head: true });

    const { data: sub } = await supabase
      .from("subscriptions")
      .select("status, scan_quota")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle();

    const quota = computeQuota({
      scans_used: count ?? 0,
      subscription: sub as Pick<SubscriptionsRow, "status" | "scan_quota"> | null,
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

  // 5. Sanitize filename, build metadata, score in memory. Raw file bytes
  //    are NEVER persisted — only the derived metadata + signals + score.
  const sanitizedName = sanitizeFilename(file.name || "document");
  const docType = parsedDocType ?? inferDocType(sanitizedName);

  const buf = Buffer.from(await file.arrayBuffer());
  const pdfMeta =
    file.type === "application/pdf" ? extractPdfMetadata(buf) : {};

  const metadata: DocumentMetadata = {
    filename: sanitizedName,
    mime: file.type || "application/octet-stream",
    size: file.size,
    ...pdfMeta,
  };

  const scoringInput: ScoringInput = { metadata, doc_type: docType };
  const { score, signals } = computeFraudScore(scoringInput);

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
      })
      .select("id")
      .single();

    if (error || !data) {
      console.error("[scan] insert error:", error);
      return NextResponse.json(
        { error: "Failed to record scan" },
        { status: 500 },
      );
    }

    const response: CreateScanResponse = { id: data.id as string };
    return NextResponse.json(response, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    console.error("[scan] unhandled error:", e);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
