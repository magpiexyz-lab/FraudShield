// The anonymous free-scan limits, pinned against the authenticated ones.
//
// THE INVARIANT: an anonymous upload must never be laxer than a signed-in one.
// The anonymous surface has no account behind it, so these two constants are
// the only thing bounding its cost and its blast radius. A change that widened
// them would not fail any other test — the route would simply start accepting
// more from callers it cannot identify.
//
// ANON_ACCEPTED_MIME is DERIVED from ACCEPTED_MIME by filtering, never retyped
// as a literal. These tests exist to keep it that way: a second hand-written
// list is how adding a format to one surface silently fails to reach the
// other, and how removing one silently leaves the anonymous path accepting it.

import { describe, it, expect } from "vitest";
import {
  ACCEPTED_MIME,
  ANON_ACCEPTED_MIME,
  MAX_ANON_BYTES,
  MAX_BYTES,
} from "@/lib/scan-intake";

describe("anonymous free-scan intake limits", () => {
  // POSITIVE CONTROL, and it comes first on purpose. Every other assertion
  // here is satisfied vacuously by an empty set: a filter bug that matched
  // nothing would be a strict subset of anything, would contain no PDF, and
  // would have every member start with "image/". Without this, a broken
  // derivation reads as a clean pass and the anonymous surface accepts nothing
  // at all.
  it("accepts at least one format", () => {
    expect(ANON_ACCEPTED_MIME.size).toBeGreaterThan(0);
  });

  it("accepts nothing the authenticated path rejects", () => {
    for (const mime of ANON_ACCEPTED_MIME) {
      expect(ACCEPTED_MIME.has(mime), `${mime} is not in ACCEPTED_MIME`).toBe(
        true,
      );
    }
  });

  // Strict, not merely equal: the anonymous path is deliberately narrower. If
  // these ever match in size, the filter has stopped excluding anything.
  it("accepts strictly fewer formats than the authenticated path", () => {
    expect(ANON_ACCEPTED_MIME.size).toBeLessThan(ACCEPTED_MIME.size);
  });

  // PDFs are the expensive, higher-risk branch — vision.ts ships the whole
  // document to the model rather than a downscaled image.
  it("does not accept PDFs", () => {
    expect(ANON_ACCEPTED_MIME.has("application/pdf")).toBe(false);
  });

  it("accepts images only", () => {
    for (const mime of ANON_ACCEPTED_MIME) {
      expect(mime.startsWith("image/"), `${mime} is not an image type`).toBe(
        true,
      );
    }
  });

  it("caps an anonymous upload below the authenticated cap", () => {
    expect(MAX_ANON_BYTES).toBeLessThan(MAX_BYTES);
  });
});

// runFraudScan takes a Buffer, not a File, so it reports metadata.size as
// buf.byteLength where the route used to pass file.size. The
// `unusually_small_file` detector in lib/fraud/score.ts reads that field and
// fires under 10 KB, so the two have to be the same number — otherwise the
// substitution silently changes which uploads trip the detector.
//
// True by construction, and pinned here because nothing else asserts it:
// multi-byte content is the case where a length-vs-bytes mix-up would show up.
describe("buffer length is the file size runFraudScan reports", () => {
  it.each([
    ["ascii", "hello world"],
    ["multi-byte", "pay stub — €1,234.56 ✓"],
  ])("agrees with File.size for %s content", async (_label, content) => {
    const file = new File([content], "stub.png", { type: "image/png" });
    const buf = Buffer.from(await file.arrayBuffer());
    expect(buf.byteLength).toBe(file.size);
  });
});
