import { describe, it, expect } from "vitest";
import { computeFraudScore, type DocumentMetadata, type ScoringInput } from "./score";

// ---- Helpers ----

function makeInput(
  overrides: Partial<DocumentMetadata> = {},
  doc_type: ScoringInput["doc_type"] = "pay_stub"
): ScoringInput {
  return {
    metadata: {
      filename: "document.pdf",
      mime: "application/pdf",
      size: 120_000,
      ...overrides,
    },
    doc_type,
  };
}

// ---- Score range / severity bucket tests ----

describe("computeFraudScore — score range and severity buckets", () => {
  it("returns score in [0, 100] for a clean document", () => {
    const result = computeFraudScore(makeInput({
      pdf_producer: "Adobe Acrobat 2024",
      pdf_creator: "QuickBooks Payroll",
      pdf_created: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("returns severity 'clear' for score 0–33", () => {
    const result = computeFraudScore(makeInput({
      pdf_producer: "Adobe Acrobat",
      pdf_creator: "Microsoft Word",
      pdf_created: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      size: 200_000,
    }));
    if (result.score <= 33) {
      expect(result.severity).toBe("clear");
    }
  });

  it("returns severity 'fraud' when score >= 67", () => {
    // Future date alone = weight 40 → score 40, within suspect. Need combined signals.
    const result = computeFraudScore(makeInput({
      pdf_producer: "ReportLab",
      pdf_creator: "Canva",
      pdf_created: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(), // future
      filename: "fake-paystub.pdf",
      size: 5_000,
    }));
    expect(result.score).toBeGreaterThanOrEqual(67);
    expect(result.severity).toBe("fraud");
  });
});

// ---- Signal-specific tests ----

describe("computeFraudScore — AI library detection", () => {
  it("flags ReportLab as a fraud signal", () => {
    const result = computeFraudScore(makeInput({ pdf_producer: "ReportLab 4.0.4" }));
    const signal = result.signals.find((s) => s.id === "ai_library_producer");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("fraud");
    expect(signal?.weight).toBeGreaterThanOrEqual(30);
  });

  it("flags wkhtmltopdf as a fraud signal", () => {
    const result = computeFraudScore(makeInput({ pdf_producer: "wkhtmltopdf 0.12.6" }));
    const signal = result.signals.find((s) => s.id === "ai_library_producer");
    expect(signal).toBeDefined();
  });

  it("flags Puppeteer PDF as a fraud signal", () => {
    const result = computeFraudScore(makeInput({ pdf_creator: "Puppeteer PDF Generator" }));
    const signal = result.signals.find((s) => s.id === "ai_library_producer");
    expect(signal).toBeDefined();
  });

  it("does NOT flag Adobe Acrobat", () => {
    const result = computeFraudScore(makeInput({ pdf_producer: "Adobe Acrobat 2024" }));
    expect(result.signals.find((s) => s.id === "ai_library_producer")).toBeUndefined();
  });
});

describe("computeFraudScore — known fraud template detection", () => {
  it("flags known pay stub creator service", () => {
    const result = computeFraudScore(makeInput({ pdf_producer: "paystubcreator.net v2" }));
    const signal = result.signals.find((s) => s.id === "known_fraud_template_producer");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("fraud");
  });

  it("flags Canva (design tool) as fraud for financial docs", () => {
    const result = computeFraudScore(makeInput({ pdf_creator: "Canva 1.0" }));
    const signal = result.signals.find((s) => s.id === "known_fraud_template_creator");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("fraud");
  });

  it("flags PDFFiller as suspect", () => {
    const result = computeFraudScore(makeInput({ pdf_creator: "PDFFiller" }));
    const signal = result.signals.find((s) => s.id === "known_fraud_template_creator");
    expect(signal).toBeDefined();
  });
});

describe("computeFraudScore — metadata completeness", () => {
  it("flags fully stripped PDF metadata as suspect", () => {
    const result = computeFraudScore(makeInput({
      pdf_producer: undefined,
      pdf_creator: undefined,
      pdf_created: undefined,
    }));
    const signal = result.signals.find((s) => s.id === "missing_pdf_metadata");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("suspect");
  });

  it("does NOT flag partial metadata (producer present)", () => {
    const result = computeFraudScore(makeInput({
      pdf_producer: "Microsoft Word",
      pdf_creator: undefined,
      pdf_created: undefined,
    }));
    expect(result.signals.find((s) => s.id === "missing_pdf_metadata")).toBeUndefined();
  });

  it("does NOT flag non-PDF files for missing metadata", () => {
    const result = computeFraudScore(makeInput({
      mime: "image/jpeg",
      pdf_producer: undefined,
    }));
    expect(result.signals.find((s) => s.id === "missing_pdf_metadata")).toBeUndefined();
  });
});

describe("computeFraudScore — timestamp anomalies", () => {
  it("flags future creation date as fraud", () => {
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeFraudScore(makeInput({ pdf_created: futureDate }));
    const signal = result.signals.find((s) => s.id === "future_date");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("fraud");
  });

  it("flags future modification date as fraud", () => {
    const pastDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeFraudScore(makeInput({
      pdf_created: pastDate,
      pdf_modified: futureDate,
    }));
    const signal = result.signals.find((s) => s.id === "future_date");
    expect(signal).toBeDefined();
  });

  it("flags modification before creation as suspect", () => {
    const earlier = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const later = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // earlier calendar = older
    const result = computeFraudScore(makeInput({
      pdf_created: earlier,   // newer date
      pdf_modified: later,    // older date (before creation)
    }));
    const signal = result.signals.find((s) => s.id === "anomalous_modification");
    expect(signal).toBeDefined();
  });

  it("flags instant modification (batch generator artifact)", () => {
    const ts = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const tsPlus1s = new Date(ts.getTime() + 500); // 500ms after creation
    const result = computeFraudScore(makeInput({
      pdf_created: ts.toISOString(),
      pdf_modified: tsPlus1s.toISOString(),
    }));
    const signal = result.signals.find((s) => s.id === "anomalous_modification");
    expect(signal).toBeDefined();
  });

  it("does NOT flag a legitimate 10-minute editing gap", () => {
    const created = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const modified = new Date(created.getTime() + 10 * 60 * 1000); // 10 minutes later
    const result = computeFraudScore(makeInput({
      pdf_created: created.toISOString(),
      pdf_modified: modified.toISOString(),
    }));
    expect(result.signals.find((s) => s.id === "anomalous_modification")).toBeUndefined();
  });

  it("flags recently created document (< 7 days)", () => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeFraudScore(makeInput({ pdf_created: recentDate }));
    const signal = result.signals.find((s) => s.id === "recently_created");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("suspect");
  });
});

describe("computeFraudScore — filename analysis", () => {
  it("flags filename containing 'fake'", () => {
    const result = computeFraudScore(makeInput({ filename: "fake-paystub.pdf" }));
    const signal = result.signals.find((s) => s.id === "suspicious_filename");
    expect(signal).toBeDefined();
  });

  it("flags filename containing 'template'", () => {
    const result = computeFraudScore(makeInput({ filename: "pay-stub-template.pdf" }));
    expect(result.signals.find((s) => s.id === "suspicious_filename")).toBeDefined();
  });

  it("does NOT flag a normal filename", () => {
    const result = computeFraudScore(makeInput({ filename: "october_statement.pdf" }));
    expect(result.signals.find((s) => s.id === "suspicious_filename")).toBeUndefined();
  });
});

describe("computeFraudScore — file size", () => {
  it("flags unusually small PDF (< 10 KB)", () => {
    const result = computeFraudScore(makeInput({ size: 5_000 }));
    const signal = result.signals.find((s) => s.id === "unusually_small_file");
    expect(signal).toBeDefined();
    expect(signal?.severity).toBe("suspect");
  });

  it("does NOT flag normal-sized PDF (> 10 KB)", () => {
    const result = computeFraudScore(makeInput({ size: 150_000 }));
    expect(result.signals.find((s) => s.id === "unusually_small_file")).toBeUndefined();
  });

  it("does NOT flag small image files (size check is PDF-only)", () => {
    const result = computeFraudScore(makeInput({ mime: "image/jpeg", size: 5_000 }));
    expect(result.signals.find((s) => s.id === "unusually_small_file")).toBeUndefined();
  });
});

describe("computeFraudScore — combined signals accumulate correctly", () => {
  it("accumulates weights from multiple signals", () => {
    const result = computeFraudScore(makeInput({
      pdf_producer: "ReportLab",              // weight: 35 (ai_library)
      filename: "fake-pay-stub.pdf",          // weight: 10 (suspicious_filename)
      size: 5_000,                            // weight: 12 (unusually_small_file)
    }));
    // Total >= 57 → score >= 57 → suspect at minimum
    expect(result.score).toBeGreaterThanOrEqual(57);
    expect(result.signals.length).toBeGreaterThanOrEqual(3);
  });

  it("returns no signals for a clean document", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const result = computeFraudScore(makeInput({
      pdf_producer: "Adobe Acrobat Pro DC",
      pdf_creator: "QuickBooks Desktop",
      pdf_created: thirtyDaysAgo,
      pdf_modified: twentyNineDaysAgo,
      filename: "payslip_oct_2025.pdf",
      size: 250_000,
    }));
    expect(result.signals).toHaveLength(0);
    expect(result.score).toBe(0);
    expect(result.severity).toBe("clear");
  });
});
