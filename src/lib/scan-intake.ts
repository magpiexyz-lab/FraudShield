// Upload intake: what /api/scan will accept, and the metadata extraction that
// turns accepted bytes into the forensic fields lib/fraud/score.ts consumes.
//
// Extracted from src/app/api/scan/route.ts so the anonymous free-scan surface
// can enforce the SAME gates as the authenticated route. Two copies of an
// accept-list is how one surface silently starts accepting what the other
// rejects.

import exifr from "exifr";
import type { DocumentMetadata } from "@/lib/fraud/score";

/** The document types the scoring engine is calibrated for. */
export type DocType = "pay_stub" | "bank_statement" | "invoice";

// Server-side accepted MIME + size cap (client also checks; the server is the
// authoritative gate).
export const ACCEPTED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
]);
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

// Sanitize a user-supplied filename before any string interpolation.
// Per nextjs.md SK "When handling file uploads".
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\]/g, "-")
    .replace(/\.\./g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 255);
}

// Infer doc_type from a sanitized filename when the client did not provide one.
export function inferDocType(
  name: string,
): "pay_stub" | "bank_statement" | "invoice" {
  const n = name.toLowerCase();
  if (n.includes("bank") || n.includes("statement")) return "bank_statement";
  if (n.includes("invoice") || n.includes("inv-") || n.includes("inv_"))
    return "invoice";
  return "pay_stub";
}

// Best-effort PDF metadata extraction. We pull a small slice of the buffer and
// regex-match against the Info dict — this avoids pulling a heavy PDF parser
// dependency for the MVP. Anything we can't parse just stays undefined.
export function extractPdfMetadata(buf: Buffer): Partial<DocumentMetadata> {
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

// Best-effort EXIF extraction for image uploads. Pulls the forensic fields the
// image detectors in lib/fraud/score.ts consume: the Software tag (the image
// analog of /Producer), DateTimeOriginal, and whether any EXIF block existed at
// all — an empty EXIF is itself a signal (screenshot / editor export / stripped).
// A file we cannot parse is reported as EXIF-absent rather than throwing.
export async function extractImageMetadata(
  buf: Buffer,
): Promise<Partial<DocumentMetadata>> {
  const meta: Partial<DocumentMetadata> = { exif_present: false };

  let tags: Record<string, unknown> | undefined;
  try {
    tags =
      // tiff covers IFD0 (where Software lives); exif covers DateTimeOriginal.
      (await exifr.parse(buf, { tiff: true, exif: true })) ?? undefined;
  } catch {
    return meta;
  }
  if (!tags || Object.keys(tags).length === 0) return meta;

  meta.exif_present = true;

  // Software is user-controlled text — cap its length before it reaches the
  // signal detail string that the UI renders.
  const software = tags.Software;
  if (typeof software === "string" && software.trim()) {
    meta.exif_software = software.trim().slice(0, 200);
  }

  // exifr returns Date objects for EXIF date tags when parseable.
  const captured = tags.DateTimeOriginal;
  if (captured instanceof Date && !Number.isNaN(captured.getTime())) {
    meta.exif_datetime_original = captured.toISOString();
  } else if (typeof captured === "string") {
    const parsed = new Date(captured);
    if (!Number.isNaN(parsed.getTime())) {
      meta.exif_datetime_original = parsed.toISOString();
    }
  }

  return meta;
}

// Anonymous free-scan limits. Deliberately STRICTER than the authenticated
// path: an anonymous upload must never be laxer, and these two constants are
// what bound the cost of an uncapped-by-account surface.
export const ANON_ACCEPTED_MIME: ReadonlySet<string> = new Set(
  [...ACCEPTED_MIME].filter((m) => m.startsWith("image/")),
);
export const MAX_ANON_BYTES = 4 * 1024 * 1024; // 4 MB
