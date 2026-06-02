/**
 * Forensic fraud-scoring engine — pure, testable module.
 *
 * Takes parsed document metadata and cross-field inputs, returns a 0–100 fraud
 * score plus a per-signal breakdown. No I/O, no side-effects — safe to unit test.
 *
 * Severity buckets:
 *   clear   0–33   — low probability of fraud
 *   suspect 34–66  — warrants manual review
 *   fraud   67–100 — strong fraud indicators
 *
 * Raw documents are NEVER stored — only the metadata + score are persisted.
 */

import type { FraudSignal } from "@/lib/types";

// ---- Public types ----

export type DocumentMetadata = {
  /** Original filename (user-supplied, sanitized by the API route before passing here) */
  filename: string;
  /** MIME type as detected server-side (e.g., "application/pdf", "image/jpeg") */
  mime: string;
  /** File size in bytes */
  size: number;
  /** PDF producer field (e.g., "Adobe Acrobat", "Microsoft Word") */
  pdf_producer?: string;
  /** PDF creator application (e.g., "Canva", "PDFCreator") */
  pdf_creator?: string;
  /** PDF CreationDate (ISO string) */
  pdf_created?: string;
  /** PDF ModDate (ISO string) */
  pdf_modified?: string;
  /** Number of pages */
  page_count?: number;
};

export type ScoringInput = {
  metadata: DocumentMetadata;
  /** Parsed document type (pay_stub | bank_statement | invoice) */
  doc_type: "pay_stub" | "bank_statement" | "invoice";
};

export type ScoringResult = {
  /** Overall fraud score 0–100 */
  score: number;
  /** Per-signal breakdown */
  signals: FraudSignal[];
  /** Overall severity based on score bucket */
  severity: "clear" | "suspect" | "fraud";
};

// ---- Known fraud-template fingerprints ----
// A small seeded list of PDF producer/creator strings associated with
// known fake document templates or AI-generated document tools.
// Grows post-launch via the dataset moat (/iterate).

const KNOWN_FRAUD_PRODUCERS = new Set([
  "fillpdf",
  "pdfcandy",
  "smallpdf stub",
  "ilovepdf",
  "docufixer",
  "paystubcreator",
  "stub creator",
  "thepaystubs",
  "paystubsnow",
  "checkstubmaker",
  "123paystubs",
  "real check stubs",
  "ai pay stub",
  "gpt paystub",
  "chatgpt document",
]);

const KNOWN_FRAUD_CREATORS = new Set([
  "canva",
  "microsoft publisher",
  "inkscape",
  "scribus",
  "libreoffice writer",  // not fraud on its own — weight is low
  "pdffiller",
  "jotform",
  "formswift",
  "docutools",
  "paystub generator",
  "fakepaycheck",
]);

// AI PDF library signatures (strong fraud indicator for financial docs)
const AI_PDF_LIBRARY_PATTERNS = [
  /reportlab/i,
  /fpdf/i,
  /pdfkit/i,
  /weasyprint/i,
  /puppeteer/i,
  /playwright.*pdf/i,
  /headless.*chrome/i,
  /chrome.*headless/i,
  /wkhtmltopdf/i,
  /dompdf/i,
  /html2pdf/i,
  /jspdf/i,
];

// ---- Detection helpers ----

/** Normalize a string for case-insensitive matching */
function norm(s: string | undefined): string {
  return (s ?? "").toLowerCase().trim();
}

/**
 * Check if creation date is suspiciously recent (< 7 days before upload).
 * Fraudsters typically create documents immediately before submission.
 */
function isRecentlyCreated(created: string | undefined): boolean {
  if (!created) return false;
  try {
    const createdMs = new Date(created).getTime();
    const nowMs = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    return nowMs - createdMs < sevenDaysMs;
  } catch {
    return false;
  }
}

/**
 * Check if modification date is AFTER creation date by only a few seconds.
 * Legitimate PDF generators produce creation ≤ modification; a rapid same-second
 * or near-instant modification gap is a batch-generator artifact.
 */
function hasAnomalousModification(
  created: string | undefined,
  modified: string | undefined
): boolean {
  if (!created || !modified) return false;
  try {
    const createdMs = new Date(created).getTime();
    const modifiedMs = new Date(modified).getTime();
    // Modified before creation — impossible from a legitimate tool
    if (modifiedMs < createdMs) return true;
    // Modified within 2 seconds of creation — batch-generation artifact
    if (modifiedMs - createdMs < 2000) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if creation date is in the future (obvious fraud indicator).
 */
function isFutureDate(date: string | undefined): boolean {
  if (!date) return false;
  try {
    return new Date(date).getTime() > Date.now();
  } catch {
    return false;
  }
}

// ---- Signal detectors ----
// Each detector returns a FraudSignal or null.

function detectAiLibrary(input: ScoringInput): FraudSignal | null {
  const producer = norm(input.metadata.pdf_producer);
  const creator = norm(input.metadata.pdf_creator);
  const combined = producer + " " + creator;

  for (const pattern of AI_PDF_LIBRARY_PATTERNS) {
    if (pattern.test(combined)) {
      return {
        id: "ai_library_producer",
        label: "AI/programmatic PDF generator detected",
        severity: "fraud",
        detail: `PDF produced by "${input.metadata.pdf_producer ?? input.metadata.pdf_creator}" — a library associated with programmatically generated documents. Legitimate pay stubs, bank statements, and invoices are produced by accounting software or issued directly from financial systems.`,
        weight: 35,
      };
    }
  }
  return null;
}

function detectKnownFraudTemplate(input: ScoringInput): FraudSignal | null {
  const producer = norm(input.metadata.pdf_producer);
  const creator = norm(input.metadata.pdf_creator);

  for (const fp of KNOWN_FRAUD_PRODUCERS) {
    if (producer.includes(fp)) {
      return {
        id: "known_fraud_template_producer",
        label: "Known fake-document template producer",
        severity: "fraud",
        detail: `PDF producer "${input.metadata.pdf_producer}" matches a known pay stub / document template service in the fraud-template database.`,
        weight: 40,
      };
    }
  }

  for (const fc of KNOWN_FRAUD_CREATORS) {
    if (creator.includes(fc)) {
      // Canva and similar design tools are higher-weight fraud signals for
      // financial documents; generic office tools get lower weight.
      const isDesignTool = ["canva", "inkscape", "scribus"].some((t) =>
        creator.includes(t)
      );
      return {
        id: "known_fraud_template_creator",
        label: isDesignTool
          ? "Document created with a graphic-design tool"
          : "Document created with a non-financial-system tool",
        severity: isDesignTool ? "fraud" : "suspect",
        detail: `PDF creator "${input.metadata.pdf_creator}" is a ${isDesignTool ? "graphic-design tool (Canva, Inkscape, etc.)" : "generic document tool"} rather than accounting or payroll software. Legitimate ${input.doc_type.replace("_", " ")} documents are generated by financial systems.`,
        weight: isDesignTool ? 30 : 15,
      };
    }
  }

  return null;
}

function detectMissingMetadata(input: ScoringInput): FraudSignal | null {
  if (input.metadata.mime !== "application/pdf") return null;
  const hasProducer = !!input.metadata.pdf_producer;
  const hasCreator = !!input.metadata.pdf_creator;
  const hasCreationDate = !!input.metadata.pdf_created;

  if (!hasProducer && !hasCreator && !hasCreationDate) {
    return {
      id: "missing_pdf_metadata",
      label: "PDF metadata has been stripped",
      severity: "suspect",
      detail: "The PDF contains no producer, creator, or creation-date metadata. Stripping PDF metadata is a common technique used to remove evidence of the generating tool from fraudulent documents.",
      weight: 20,
    };
  }
  return null;
}

function detectRecentCreation(input: ScoringInput): FraudSignal | null {
  if (!isRecentlyCreated(input.metadata.pdf_created)) return null;
  return {
    id: "recently_created",
    label: "Document created within the last 7 days",
    severity: "suspect",
    detail: `The document was created on ${input.metadata.pdf_created}. Documents submitted for verification that were created very recently can indicate fabrication shortly before submission.`,
    weight: 15,
  };
}

function detectFutureDate(input: ScoringInput): FraudSignal | null {
  const hasFutureCreation = isFutureDate(input.metadata.pdf_created);
  const hasFutureModification = isFutureDate(input.metadata.pdf_modified);

  if (hasFutureCreation || hasFutureModification) {
    return {
      id: "future_date",
      label: "Document contains a future timestamp",
      severity: "fraud",
      detail: `The document's ${hasFutureCreation ? "creation" : "modification"} date is in the future. This is impossible for a legitimate document and indicates metadata manipulation.`,
      weight: 40,
    };
  }
  return null;
}

function detectAnomalousModification(input: ScoringInput): FraudSignal | null {
  if (!hasAnomalousModification(input.metadata.pdf_created, input.metadata.pdf_modified))
    return null;
  return {
    id: "anomalous_modification",
    label: "Suspicious modification timestamp",
    severity: "suspect",
    detail: `The PDF modification date is ${input.metadata.pdf_modified} — either before the creation date or within 2 seconds of it. This pattern occurs when batch-generation tools set both timestamps simultaneously.`,
    weight: 18,
  };
}

function detectSuspiciousFilename(input: ScoringInput): FraudSignal | null {
  const name = norm(input.metadata.filename);
  const fraudKeywords = [
    "fake", "template", "sample", "example", "test", "dummy",
    "edit", "editable", "fillable", "stub", "generated",
  ];
  for (const kw of fraudKeywords) {
    if (name.includes(kw)) {
      return {
        id: "suspicious_filename",
        label: "Filename contains a fraud-related keyword",
        severity: "suspect",
        detail: `The filename "${input.metadata.filename}" contains "${kw}", which is commonly found in template or fraudulent document filenames.`,
        weight: 10,
      };
    }
  }
  return null;
}

function detectUnusualFileSize(input: ScoringInput): FraudSignal | null {
  // Very small PDFs (< 10 KB) for financial documents are suspicious — real bank
  // statements and pay stubs typically contain embedded fonts, images, and multiple
  // pages that push size above 50 KB.
  if (input.metadata.mime !== "application/pdf") return null;
  if (input.metadata.size < 10_000) {
    return {
      id: "unusually_small_file",
      label: "Unusually small PDF for a financial document",
      severity: "suspect",
      detail: `The PDF is only ${Math.round(input.metadata.size / 1024)} KB. Legitimate financial documents (pay stubs, bank statements, invoices) typically contain embedded fonts and images, resulting in files larger than 50 KB.`,
      weight: 12,
    };
  }
  return null;
}

// ---- Score computation ----

/** Map raw weight sum to a 0–100 score using a sigmoid-like curve */
function computeScore(totalWeight: number): number {
  // Cap at 100 and clamp to [0, 100]
  return Math.min(100, Math.max(0, Math.round(totalWeight)));
}

/** Derive severity bucket from score */
function scoreSeverity(score: number): "clear" | "suspect" | "fraud" {
  if (score >= 67) return "fraud";
  if (score >= 34) return "suspect";
  return "clear";
}

// ---- Main export ----

/**
 * Compute a fraud score for a document based on its metadata.
 *
 * This is a pure function — no I/O, no side effects. The API route calls this
 * after extracting metadata from the uploaded file.
 *
 * @param input - Parsed document metadata + document type
 * @returns ScoringResult with score (0–100), signals array, and severity bucket
 */
export function computeFraudScore(input: ScoringInput): ScoringResult {
  const detectors = [
    detectFutureDate,
    detectAiLibrary,
    detectKnownFraudTemplate,
    detectMissingMetadata,
    detectRecentCreation,
    detectAnomalousModification,
    detectSuspiciousFilename,
    detectUnusualFileSize,
  ];

  const signals: FraudSignal[] = [];

  for (const detect of detectors) {
    const signal = detect(input);
    if (signal) signals.push(signal);
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = computeScore(totalWeight);
  const severity = scoreSeverity(score);

  return { score, signals, severity };
}
