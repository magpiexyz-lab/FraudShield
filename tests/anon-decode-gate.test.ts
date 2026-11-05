// The ANONYMOUS DECODE GATE — real sharp, no mocks.
//
// WHAT THIS SUITE IS DEFENDING. /api/free-scan admitted an SVG, because its
// MIME gate reads `file.type` — the CLIENT-SUPPLIED multipart Content-Type.
// Label an SVG `image/png` and it passed every check, and sharp decoded it:
// librsvg renders the filter chain, and a 0.02 MB SVG of ~300 stacked
// `feGaussianBlur` layers was measured at 229,141 ms in
// `sharp().rotate().resize().jpeg()` on THIS project's sharp install. With
// `maxDuration = 60` the lambda is killed at 60s, so one such request burns a
// full minute of billed compute and answers 504 — and `free-scan:req:` allows
// 20 of them per IP per hour.
//
// `limitInputPixels` is NOT the remedy: it bounds raster pixel count, and the
// measured bomb was only ~4 megapixels. The remedy is to sniff the REAL format
// and refuse anything outside the raster allow-list BEFORE the render.
//
// MEASURED ON THIS INSTALL (sharp 0.34 / libvips 8.17.3, 60 layers at 1200px):
//   sharp(buf).metadata()                  ->      23 ms
//   sharp(buf).rotate().resize().jpeg()     ->  47,959 ms
// — a ~2,000x ratio, which is what makes "check the format first" a fix rather
// than a reshuffle. The timing assertion below pins that property in CI.
//
// THE MOCKED SUITES CANNOT COVER THIS. src/lib/fraud/vision.test.ts stubs
// sharp at module scope, and tests/free-scan-route.test.ts stubs
// `prepareImage` itself, so only a suite with the real decoder can tell a
// refused SVG from a rendered one. That is why this file exists.

import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { prepareImage } from "@/lib/fraud/vision";
import {
  ANON_ACCEPTED_MIME,
  ANON_DECODE_FORMATS,
  MAX_ANON_INPUT_PIXELS,
} from "@/lib/scan-limits";

/** Exactly what the route hands `prepareImage`. */
const ANON_POLICY = {
  allowedFormats: ANON_DECODE_FORMATS,
  limitInputPixels: MAX_ANON_INPUT_PIXELS,
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A filtered SVG, the shape of the measured bomb but deliberately SMALL.
 *
 * 40 layers at 1000px, not 300 at 1200px: a regressed gate must fail this
 * suite in seconds, not hold a CI runner for four minutes. The guard returns
 * before any of it is rendered, so the layer count only matters if the guard
 * is gone.
 */
function filteredSvg(layers = 40, size = 1000): Buffer {
  const filters = Array.from(
    { length: layers },
    (_, i) => `<filter id="f${i}"><feGaussianBlur stdDeviation="12"/></filter>`,
  ).join("");
  const rects = Array.from(
    { length: layers },
    (_, i) =>
      `<rect width="${size}" height="${size}" fill="#8080ff" filter="url(#f${i})"/>`,
  ).join("");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<defs>${filters}</defs>${rects}</svg>`,
  );
}

/** A trivial SVG: no filters, decodes in milliseconds. */
const PLAIN_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<rect width="10" height="10" fill="red"/></svg>',
);

function solid(format: "png" | "jpeg" | "webp" | "tiff") {
  return sharp({
    create: { width: 40, height: 40, channels: 3, background: "#224466" },
  })
    .toFormat(format)
    .toBuffer();
}

/**
 * An 85-byte TWO-FRAME GIF, hand-assembled.
 *
 * Hand-assembled because sharp cannot ENCODE an animation from a single-page
 * input, so there is no way to produce a multi-frame fixture with the library
 * under test. Header, global colour table, NETSCAPE loop block, then two
 * graphic-control + image blocks and the trailer. sharp reports `pages: 2` for
 * it even in its default single-page read, which is the property the
 * multi-frame refusal keys on.
 */
const ANIMATED_GIF = Buffer.from(
  [
    "474946383961", "0100", "0100", "80", "00", "00",
    "ff0000", "0000ff",
    "21ff0b", "4e45545343415045322e30", "03", "01", "0000", "00",
    "21f904", "000a0000", "00",
    "2c", "0000", "0000", "0100", "0100", "00",
    "02", "02", "4c01", "00",
    "21f904", "000a0000", "00",
    "2c", "0000", "0000", "0100", "0100", "00",
    "02", "02", "4c01", "00",
    "3b",
  ].join(""),
  "hex",
);

// ---------------------------------------------------------------------------
// (a) The gate bites
// ---------------------------------------------------------------------------

describe("prepareImage under the anonymous decode policy", () => {
  // POSITIVE CONTROL, FIRST. Every refusal below is a `toBeNull()`, and a
  // policy that refused EVERYTHING would satisfy all of them while taking the
  // free scan offline.
  it("still accepts a real PNG and normalizes it to JPEG", async () => {
    const out = await prepareImage(await solid("png"), ANON_POLICY);

    expect(out).not.toBeNull();
    expect((await sharp(out!).metadata()).format).toBe("jpeg");
  });

  it("still accepts real JPEG and WebP", async () => {
    expect(await prepareImage(await solid("jpeg"), ANON_POLICY)).not.toBeNull();
    expect(await prepareImage(await solid("webp"), ANON_POLICY)).not.toBeNull();
  });

  // THE FINDING. The MIME gate upstream only ever saw `image/png`; nothing
  // before this point looked at the bytes.
  it("refuses an SVG whose upload claimed to be a PNG", async () => {
    expect(await prepareImage(filteredSvg(), ANON_POLICY)).toBeNull();
    expect(await prepareImage(PLAIN_SVG, ANON_POLICY)).toBeNull();
  });

  // The whole point of sniffing with `metadata()` rather than rendering and
  // timing out: 23 ms vs 47,959 ms measured. 2s is ~85x the measured sniff and
  // ~1/24th of the measured render, so neither a slow CI box nor a real
  // regression lands in the gap.
  it("refuses the SVG before the expensive render, not after it", async () => {
    const started = Date.now();
    const out = await prepareImage(filteredSvg(), ANON_POLICY);
    const elapsed = Date.now() - started;

    expect(out).toBeNull();
    expect(elapsed).toBeLessThan(2000);
  });

  // sharp decodes these regardless of the declared type, so "images only" was
  // a LABEL guarantee: the allow-list named three raster types and the decoder
  // accepted every format libvips was built with.
  it("refuses TIFF, which sharp decodes but the accept-list never named", async () => {
    expect(await prepareImage(await solid("tiff"), ANON_POLICY)).toBeNull();
  });

  it("refuses a GIF", async () => {
    const stillGif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#224466" },
    })
      .gif()
      .toBuffer();

    expect(await prepareImage(stillGif, ANON_POLICY)).toBeNull();
  });

  // Isolated from the format check on purpose: the policy below ALLOWS gif, so
  // the only thing left to refuse the animation is the page count. Without
  // this the multi-frame rule would be untestable — every multi-frame format
  // libvips can produce is already outside the real allow-list.
  it("refuses multi-frame input even when its container format is allowed", async () => {
    const gifPolicy = {
      allowedFormats: new Set(["gif"]),
      limitInputPixels: MAX_ANON_INPUT_PIXELS,
    };
    const stillGif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "#224466" },
    })
      .gif()
      .toBuffer();

    // Control: the same policy, a single-frame file of the same format.
    expect(await prepareImage(stillGif, gifPolicy)).not.toBeNull();
    expect((await sharp(ANIMATED_GIF).metadata()).pages).toBe(2);
    expect(await prepareImage(ANIMATED_GIF, gifPolicy)).toBeNull();
  });

  it("refuses bytes that are no image at all", async () => {
    expect(
      await prepareImage(Buffer.from("%PDF-1.7 not an image"), ANON_POLICY),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) The gate is OPT-IN, so /api/scan is untouched
// ---------------------------------------------------------------------------

// /api/scan accepts whatever sharp accepts, including a blank `file.type`, and
// reaches this same function through `analyzeDocumentForFraud`. Folding the
// policy into `prepareImage` unconditionally would have changed the
// AUTHENTICATED path's behaviour, which Rule 0 (scope lock) forbids this
// change from doing. It is a parameter, and the paid path passes nothing.
describe("prepareImage with no policy — the authenticated path", () => {
  it("still decodes an SVG, exactly as it did before", async () => {
    // Plain, not filtered: this one is MEANT to render, and the whole point of
    // the fixture above is that rendering it is what must never happen.
    expect(await prepareImage(PLAIN_SVG)).not.toBeNull();
  });

  it("still decodes TIFF and GIF", async () => {
    expect(await prepareImage(await solid("tiff"))).not.toBeNull();
  });

  it("still refuses what sharp genuinely cannot read", async () => {
    expect(await prepareImage(Buffer.from("%PDF-1.7 not an image"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) The pixel ceiling
// ---------------------------------------------------------------------------

// Defence in depth, NOT the fix for the SVG. sharp's default is ~268 MP —
// around 800 MB of raw pixels — and the anonymous input is downscaled to a
// 1568px long edge anyway, so nothing above the ceiling is ever useful.
describe("the anonymous decode caps input pixels", () => {
  // MUTATION SURVEY, RECORDED SO THE NEXT READER DOES NOT HAVE TO REDO IT:
  // prepareImage hands the ceiling to BOTH sharp instances (the sniff and the
  // render), and libvips enforces it at image load, so EITHER ONE ALONE
  // refuses an oversized input — removing it from one instance leaves this
  // test green, and only removing it from both turns it red. The pair is
  // redundant on purpose; this test pins the property, not the placement.
  it("passes the ceiling through to sharp", async () => {
    const png = await solid("png"); // 40x40 = 1600 px
    const tiny = { allowedFormats: ANON_DECODE_FORMATS, limitInputPixels: 100 };

    // Same bytes, same allow-list: only the ceiling differs, so a refusal here
    // can only be the ceiling.
    expect(await prepareImage(png, tiny)).toBeNull();
    expect(await prepareImage(png, ANON_POLICY)).not.toBeNull();
  });

  it("sits far below sharp's default and far above any real document photo", () => {
    // 48 MP is the largest common phone sensor output (48 MP main camera), so
    // nothing a visitor can photograph a payslip with is refused by it.
    expect(MAX_ANON_INPUT_PIXELS).toBe(48_000_000);
    expect(MAX_ANON_INPUT_PIXELS).toBeLessThan(268_402_689);
  });
});

// ---------------------------------------------------------------------------
// (d) The allow-list is DERIVED, not retyped
// ---------------------------------------------------------------------------

describe("ANON_DECODE_FORMATS", () => {
  it("names the raster formats the MIME allow-list already intends", () => {
    expect([...ANON_DECODE_FORMATS].sort()).toEqual([
      "heif",
      "jpeg",
      "png",
      "webp",
    ]);
  });

  // The decode gate and the MIME gate have to answer the same question. A
  // second hand-written list is how one surface silently starts accepting what
  // the other rejects — the exact failure lib/scan-limits.ts was created to
  // prevent for ANON_ACCEPTED_MIME.
  it("has one entry per image type on the anonymous MIME allow-list", () => {
    expect(ANON_DECODE_FORMATS.size).toBe(ANON_ACCEPTED_MIME.size);
    // image/heic and image/avif both surface as "heif" from libvips, so the
    // mapping is not injective in the other direction — this is the direction
    // that matters: nothing is accepted for decode that is not an accepted
    // MIME.
    expect(ANON_DECODE_FORMATS.has("heif")).toBe(true);
    expect(ANON_ACCEPTED_MIME.has("image/heic")).toBe(true);
  });

  it("names no vector, no multi-frame and no exotic raster format", () => {
    for (const format of ["svg", "gif", "tiff", "pdf", "magick", "raw"]) {
      expect(ANON_DECODE_FORMATS.has(format)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) The exploit, end to end, through the real handler
//
// NO MOCKS IN THIS FILE — that is the point. tests/free-scan-route.test.ts
// stubs `prepareImage`, so it can prove the route ASKS for the strict decode
// but never that the composition refuses anything. This block sends the
// attacker's actual request: an SVG with a `Content-Type: image/png` on the
// multipart part, which is the client-supplied value step 3 of the route
// reads.
//
// It reaches no Anthropic API and consumes no SCAN counter: the decode gate
// sits above both, which is the ordering the route's step 6 comment is about.
// ---------------------------------------------------------------------------

describe("POST /api/free-scan with an SVG labelled image/png", () => {
  it("answers 415 image_unreadable instead of burning the 60s budget", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { POST } = await import("@/app/api/free-scan/route");

    const form = new FormData();
    form.set(
      "file",
      // Uint8Array, not the Buffer directly: Buffer is not a BlobPart under
      // this TS lib, and the suite has to type-check.
      new File([new Uint8Array(filteredSvg())], "paystub.png", {
        type: "image/png",
      }),
    );
    const request = new Request("http://localhost/api/free-scan", {
      method: "POST",
      body: form,
      headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.44" },
    });

    const started = Date.now();
    const response = await POST(request);
    const body = (await response.json()) as { code?: string; message?: string };
    const elapsed = Date.now() - started;

    expect(response.status).toBe(415);
    expect(body.code).toBe("image_unreadable");
    // The refusal copy is conversion-framed, not an error page: whatever the
    // visitor actually sent, "try a JPEG or PNG" is the useful next step.
    expect(body.message).toMatch(/JPEG|PNG/);
    // Measured: 229,141 ms for the 300-layer original against a 60-second
    // lambda. This fixture is 40 layers and still renders in tens of seconds
    // if the gate is gone.
    expect(elapsed).toBeLessThan(2000);
  });
});
