// POST /api/free-scan — the anonymous free scan.
//
// WHAT THIS SUITE IS DEFENDING. The handler spends real money per accepted
// request (one `claude-opus-5` vision call) on behalf of a caller with no
// account, no session and no cost ceiling other than two rate-limit counters.
// Every assertion below is about one of two things:
//
//   1. A request that will never reach the model must not consume a token.
//      Each consumed token is 1/3 of one visitor's daily allowance or 1/30 of
//      the whole site's, and a refusal that charges for itself is a free
//      denial-of-service against the landing page's primary CTA.
//   2. The free panel must show the AI finding and the full signal count,
//      because the number it prints is only credible if the evidence shown
//      supports it.
//
// `environment: "node"` (vitest.config.ts) — no jsdom, nothing rendered here.
// The three I/O boundaries are mocked: the scan pipeline, the rate limiter and
// sharp's decode. Mocking the limiter is what makes CALL ORDER observable,
// which is the only way some of these properties can be tested at all (see (g)).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// vi.hoisted: vi.mock factories are hoisted above module scope, so they cannot
// close over plain consts declared here.
const { runFraudScan, rateLimit, prepareImage } = vi.hoisted(() => ({
  runFraudScan: vi.fn(),
  rateLimit: vi.fn(),
  prepareImage: vi.fn(),
}));

vi.mock("@/lib/fraud/run-scan", () => ({ runFraudScan }));

// The real `clientIpFromHeaders` is kept deliberately. It is the helper that
// closes the X-Forwarded-For spoofing bypass (issue #1361), and a stub of it
// here would let the route start reading the raw header without this suite
// noticing.
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit,
}));

// Only `prepareImage` is imported from vision.ts by the route; stubbing the
// module also keeps sharp and the Anthropic SDK out of this process.
vi.mock("@/lib/fraud/vision", () => ({ prepareImage }));

import { POST } from "@/app/api/free-scan/route";
import {
  ANON_DECODE_FORMATS,
  MAX_ANON_INPUT_PIXELS,
} from "@/lib/scan-limits";
import type { FraudSignal } from "@/lib/types";
import type { RateLimitResult } from "@/lib/rate-limit";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IP = "203.0.113.9";
const DAY_MS = 86_400_000;

function allowed(
  enforcement: RateLimitResult["enforcement"] = "memory_unconfigured",
): RateLimitResult {
  return {
    success: true,
    remaining: 2,
    enforcement,
    resetAt: Date.now() + DAY_MS,
  };
}

function exhausted(
  enforcement: RateLimitResult["enforcement"] = "memory_unconfigured",
): RateLimitResult {
  return {
    success: false,
    remaining: 0,
    enforcement,
    resetAt: Date.now() + DAY_MS,
  };
}

function signal(
  id: string,
  severity: FraudSignal["severity"],
  weight: number,
): FraudSignal {
  return { id, label: `label-${id}`, severity, detail: `detail-${id}`, weight };
}

/**
 * Six signals, one of them from the AI content pass.
 *
 * The vision signal is LAST because that is where `applyVisionSignals` puts it
 * (`[...base.signals, ...visionSignals]`), which is exactly why assertion (f)
 * cannot be satisfied by `signals.slice(0, 2)`.
 */
const SIGNALS: FraudSignal[] = [
  signal("missing_exif_metadata", "suspect", 12),
  signal("editor_software", "suspect", 10),
  signal("recent_modification", "clear", 4),
  signal("unusually_small_file", "clear", 3),
  signal("round_number_amounts", "suspect", 8),
  signal("vision_altered_figures", "fraud", 30),
];

function scanResult(overrides: Record<string, unknown> = {}) {
  return {
    score: 87,
    signals: SIGNALS,
    metadata: { filename: "paystub.jpg", mime: "image/jpeg", size: 1024 },
    vision: {
      status: "analyzed",
      analyzed: true,
      signals: [SIGNALS[5]],
      usage: { input_tokens: 1500, output_tokens: 300, model: "claude-opus-5" },
    },
    docType: "pay_stub",
    ...overrides,
  };
}

function uploadRequest(
  opts: { name?: string; type?: string; size?: number } = {},
): Request {
  const size = opts.size ?? 1024;
  const file = new File([new Uint8Array(size)], opts.name ?? "paystub.jpg", {
    type: opts.type ?? "image/jpeg",
  });
  const form = new FormData();
  form.set("file", file);
  // Vercel appends the verified client IP as the LAST X-Forwarded-For entry; a
  // spoofed prefix is included so the real helper has something to discard.
  return new Request("http://localhost/api/free-scan", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": `198.51.100.7, ${IP}` },
  });
}

type FreeScanBody = {
  code?: string;
  message?: string;
  error?: string;
  resetAt?: number | null;
  score?: number;
  severity?: string;
  vision_status?: string;
  // The PROJECTED shape, not FraudSignal: the wire carries no `weight`, and
  // typing it as FraudSignal here would assert a field the route no longer
  // sends.
  signals?: Array<Pick<FraudSignal, "id" | "label" | "severity" | "detail">>;
  total_signal_count?: number;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Read at request time by the route, so stubbing here is effective.
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  rateLimit.mockResolvedValue(allowed());
  prepareImage.mockResolvedValue(Buffer.from("decoded-jpeg-bytes"));
  runFraudScan.mockResolvedValue(scanResult());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// (a) Refusals that cost nothing
// ---------------------------------------------------------------------------

describe("(a) a refused upload consumes no rate-limit token", () => {
  // Each of these is refused by a gate that runs BEFORE either counter is
  // touched. If any of them starts consuming a token, an attacker gets to
  // spend the site's daily free-scan budget with files that are never scanned.
  const cases: Array<{
    label: string;
    opts: { name?: string; type?: string; size?: number };
    status: number;
    code: string;
  }> = [
    {
      label: "oversized image",
      opts: { size: 5 * 1024 * 1024 },
      status: 413,
      code: "file_too_large",
    },
    {
      label: "unsupported MIME",
      opts: { name: "notes.txt", type: "text/plain" },
      status: 415,
      code: "unsupported_type",
    },
    {
      // The one /api/scan admits on purpose (`file.type !== ""` at :210). A
      // blank-type PDF that got through here would fail EXIF extraction into
      // `missing_exif_metadata` and hand the visitor a bogus suspect verdict
      // after spending both tokens.
      label: "blank MIME",
      opts: { name: "paystub", type: "" },
      status: 415,
      code: "unsupported_type",
    },
    {
      label: "PDF",
      opts: { name: "paystub.pdf", type: "application/pdf" },
      status: 415,
      code: "pdf_not_supported",
    },
    {
      label: "empty file",
      opts: { size: 0 },
      status: 400,
      code: "empty_file",
    },
  ];

  for (const { label, opts, status, code } of cases) {
    it(`refuses a ${label} with ${status} ${code} and no token`, async () => {
      const response = await POST(uploadRequest(opts));
      const body = (await response.json()) as FreeScanBody;

      expect(response.status).toBe(status);
      expect(body.code).toBe(code);
      expect(rateLimit).not.toHaveBeenCalled();
      expect(runFraudScan).not.toHaveBeenCalled();
    });
  }

  it("refuses a missing file field with no token", async () => {
    const form = new FormData();
    form.set("file", "not-a-file");
    const response = await POST(
      new Request("http://localhost/api/free-scan", {
        method: "POST",
        body: form,
      }),
    );

    expect(response.status).toBe(400);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("refuses with 503 and no token when no API key is configured", async () => {
    // nextjs.md:556 — the configuration check precedes the limiter, so a
    // misconfigured deploy cannot burn every visitor's allowance on requests
    // that could never have reached the model.
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(response.status).toBe(503);
    expect(body.code).toBe("not_configured");
    expect(rateLimit).not.toHaveBeenCalled();
    expect(runFraudScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) + (c) The two fail-open paths are not the same path
// ---------------------------------------------------------------------------

describe("(b) a degraded limiter short-circuits before the scan", () => {
  it("refuses with cap_unavailable and never calls the scan", async () => {
    // "memory_degraded" means Upstash IS configured but threw: the real count
    // is unknown. Serving a billed AI call on an unknown count is how an
    // outage turns into an unbounded bill, so this refuses in EVERY
    // environment — and it must refuse BEFORE the spend, not after.
    rateLimit.mockResolvedValue(allowed("memory_degraded"));

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(response.status).toBe(429);
    expect(body.code).toBe("cap_unavailable");
    expect(runFraudScan).not.toHaveBeenCalled();
  });

  it("omits Retry-After when the reset time is unknown", async () => {
    // cap_unavailable carries resetAt: null — there is no window to wait for.
    rateLimit.mockResolvedValue(allowed("memory_degraded"));

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.resetAt).toBeNull();
    expect(response.headers.get("retry-after")).toBeNull();
  });
});

describe("(c) an unconfigured limiter outside production still allows the scan", () => {
  it("runs the scan under NODE_ENV=test", async () => {
    // THIS IS WHAT KEEPS THE FEATURE USABLE IN DEV, VITEST AND PLAYWRIGHT.
    // "memory_unconfigured" is the normal state everywhere Upstash
    // credentials are absent, which is every local machine and both test
    // runners. Failing closed on it — the obvious-looking "safer" reading —
    // would make the free scan 100% dead outside production, so the surface
    // would ship untested by its own e2e suite. Production keys on NODE_ENV
    // instead (decideFreeScanCap step 2), where it does fail closed.
    rateLimit.mockResolvedValue(allowed("memory_unconfigured"));
    expect(process.env.NODE_ENV).not.toBe("production");

    const response = await POST(uploadRequest());

    expect(response.status).toBe(200);
    expect(runFraudScan).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (d) + (e) + (f) The accepted path
// ---------------------------------------------------------------------------

describe("(d) an accepted request runs exactly one scan", () => {
  it("invokes the pipeline once and passes the decoded image through", async () => {
    // One invocation == one Anthropic call (runFraudScan makes exactly one).
    // Two would double the cost per visitor and halve the real cap.
    const response = await POST(uploadRequest());

    expect(response.status).toBe(200);
    expect(runFraudScan).toHaveBeenCalledTimes(1);

    const input = runFraudScan.mock.calls[0][0];
    expect(input.mime).toBe("image/jpeg");
    expect(input.filename).toBe("paystub.jpg");
    expect(Buffer.isBuffer(input.buf)).toBe(true);
    // The already-decoded buffer is handed over so the same bytes are not
    // decoded a second time inside the pipeline.
    expect(input.preparedImage).toBeInstanceOf(Buffer);
  });

  it("consumes exactly three counters: request, then per-IP, then site-wide", async () => {
    await POST(uploadRequest());

    // THREE, not two. `free-scan:req:` prices REQUESTS and is consumed above
    // the sharp decode; `free-scan:ip:` and `free-scan:global` price
    // COMPLETED SCANS and are consumed below it. The two groups are
    // deliberately separate — see the route comment at step 5.
    expect(rateLimit).toHaveBeenCalledTimes(3);
    expect(rateLimit.mock.calls[0]).toEqual([`free-scan:req:${IP}`, 20, 3600]);
    expect(rateLimit.mock.calls[1]).toEqual([`free-scan:ip:${IP}`, 3, 86400]);
    expect(rateLimit.mock.calls[2]).toEqual(["free-scan:global", 30, 86400]);
  });

  it("derives severity from the shared band thresholds", async () => {
    // scoreSeverity() is the single source of the 34/67 bands. A fourth copy
    // of those numbers is how the free panel starts disagreeing with the
    // dashboard about the same score.
    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.score).toBe(87);
    expect(body.severity).toBe("fraud");
    expect(body.vision_status).toBe("analyzed");
  });

  // The decode gate is handed the ANONYMOUS policy, which is what makes the
  // "images only" promise a property of the BYTES rather than of the
  // client-supplied Content-Type. `prepareImage` is mocked here, so the
  // refusal itself is proved against real sharp in
  // tests/anon-decode-gate.test.ts; what this suite owns is that the route
  // asks for the strict decode at all.
  it("decodes under the anonymous format allow-list and pixel ceiling", async () => {
    await POST(uploadRequest());

    expect(prepareImage).toHaveBeenCalledTimes(1);
    const [buf, policy] = prepareImage.mock.calls[0] as [
      Buffer,
      { allowedFormats: ReadonlySet<string>; limitInputPixels: number },
    ];

    expect(Buffer.isBuffer(buf)).toBe(true);
    // THE SAME OBJECTS lib/scan-limits exports, not a local copy: a second
    // list is how this route silently starts admitting a format the decode
    // policy was tightened to exclude.
    expect(policy.allowedFormats).toBe(ANON_DECODE_FORMATS);
    expect(policy.limitInputPixels).toBe(MAX_ANON_INPUT_PIXELS);
    // The finding, stated as an assertion: an SVG labelled image/png is the
    // measured 229-second decode bomb.
    expect(policy.allowedFormats.has("svg")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (d2) The response carries nothing the panel does not render
//
// The payload went to an UNAUTHENTICATED caller carrying (1) the two teaser
// signals as whole FraudSignal objects, `weight` included, and (2) `usage` —
// input/output token counts and the model name, which is operational billing
// telemetry. src/components/free-scan-panel.tsx argues at length in its own
// docstring that weights and raw ids must never reach a reader, and SignalRow
// renders only label/severity/detail; the response contradicted the component
// it feeds.
//
// SCOPE, PRECISELY. Only the two SHOWN weights ever leaked:
// `selectTeaserSignals` returns the teaser subset, so the withheld N-2 are
// never serialised and the weighted total cannot be reconstructed from the
// wire. This is minimisation, not a paywall hole — which is why it is fixed by
// projecting the fields, not by re-architecting the teaser.
// ---------------------------------------------------------------------------

describe("(d2) the success payload is minimised", () => {
  it("projects each shown signal to the four fields the panel renders", async () => {
    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.signals).toHaveLength(2);
    for (const sig of body.signals ?? []) {
      // POSITIVE CONTROL: everything SignalRow reads is present, so the
      // assertion below cannot pass on an empty or stripped object.
      expect(typeof sig.id).toBe("string");
      expect(typeof sig.label).toBe("string");
      expect(typeof sig.severity).toBe("string");
      expect(typeof sig.detail).toBe("string");
      // `id` is kept deliberately: the panel uses it as the React key at
      // free-scan-panel.tsx:942. It is never rendered.
      expect(Object.keys(sig).sort()).toEqual([
        "detail",
        "id",
        "label",
        "severity",
      ]);
    }
  });

  it("sends no signal weight and no token usage anywhere in the body", async () => {
    const response = await POST(uploadRequest());
    const text = await response.text();

    // POSITIVE CONTROL: the body IS the success payload, so a route that
    // returned `{}` could not satisfy these.
    expect(text).toContain("total_signal_count");
    expect(text).toContain("vision_altered_figures");

    expect(text).not.toContain("weight");
    expect(text).not.toContain("usage");
    expect(text).not.toContain("input_tokens");
    expect(text).not.toContain("output_tokens");
    // The model name is the other half of the billing telemetry.
    expect(text).not.toContain("claude-opus-5");
  });

  // WHERE THE COST WENT. Nothing is persisted for an anonymous scan, and the
  // panel's free_scan_complete event used to carry the token counts straight
  // off the wire. Taking them off the wire without putting them anywhere would
  // have deleted the only record of what the free tier spends, so the route
  // logs them instead — a structured server-side line, never a response field.
  it("records what the scan was billed on the server instead", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await POST(uploadRequest());

      const line = info.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(line).toContain("free-scan");
      expect(line).toContain("1500");
      expect(line).toContain("300");
      expect(line).toContain("claude-opus-5");
    } finally {
      info.mockRestore();
    }
  });

  it("logs nothing when no call reached the model", async () => {
    runFraudScan.mockResolvedValue(
      scanResult({ vision: { status: "unavailable", analyzed: false, signals: [] } }),
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await POST(uploadRequest());

      // A zero here would be a lie about what happened: the request was never
      // billed, which is not the same as being billed nothing.
      const line = info.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(line).not.toContain("input_tokens");
    } finally {
      info.mockRestore();
    }
  });
});

describe("(e) the response teases the withheld signals", () => {
  it("exposes exactly two signals and the full count", async () => {
    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.signals).toHaveLength(2);
    // The FULL count, not the shown count. The panel prints "6 forensic
    // signals found — 2 shown"; a total of 2 makes the paywall invisible and
    // the teaser pointless.
    expect(body.total_signal_count).toBe(6);
    expect(body.total_signal_count).toBe(SIGNALS.length);
  });

  it("never leaks the withheld signals in the payload", async () => {
    const response = await POST(uploadRequest());
    const text = await response.text();

    // Two shown rows means the other four ids must not appear anywhere in the
    // body — including in a stray metadata or debug field.
    expect(text).not.toContain("recent_modification");
    expect(text).not.toContain("unusually_small_file");
  });
});

describe("(f) the shown pair always includes the AI finding", () => {
  it("includes a vision signal when the scan produced one", async () => {
    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    const ids = (body.signals ?? []).map((s) => s.id);
    expect(ids.some((id) => id.startsWith("vision_"))).toBe(true);
  });

  it("shows metadata signals only when there is no AI finding", async () => {
    // A partial scan (vision unavailable) has nothing to force in, and must
    // still return two ranked rows rather than an empty list.
    const metadataOnly = SIGNALS.filter((s) => !s.id.startsWith("vision_"));
    runFraudScan.mockResolvedValue(
      scanResult({
        signals: metadataOnly,
        score: 30,
        vision: { status: "unavailable", analyzed: false, signals: [] },
      }),
    );

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.signals).toHaveLength(2);
    expect(body.total_signal_count).toBe(metadataOnly.length);
    expect(body.severity).toBe("clear");
    expect(body.vision_status).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// (g) The per-IP cap cannot be used to drain the site-wide budget
// ---------------------------------------------------------------------------

describe("(g) an IP-capped request never touches the global counter", () => {
  it("calls the limiter exactly once, with the ip-prefixed key", async () => {
    // CALL ORDERING IS THE ENTIRE DEFENCE FOR THIS PROPERTY. rateLimit() has
    // no peek: every call CONSUMES. So "the global budget was not touched" is
    // not observable from any return value, from the response, or from any
    // state the route can be asked about afterwards — it is observable only
    // as the absence of a second call. Swap the two checks in the route and
    // every other test in this file still passes while one IP, already over
    // its own limit, silently burns all 30 site-wide scans per day through
    // requests that are refused anyway.
    // First call is the coarse request counter, which has room; the SECOND
    // is the per-IP scan counter, which is the one exhausted here.
    rateLimit.mockResolvedValueOnce(allowed());
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    // The counter assertions come FIRST on purpose. Asserting `code` first
    // also catches a swap, but it reports it as "expected ip_capped, received
    // site_capped" — a message about naming, which reads like a copy bug and
    // sends the next person to the wrong file. Asserting the keys first makes
    // the failure say what actually broke: the global budget was charged.
    const keys = rateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys).not.toContain("free-scan:global");
    expect(keys).toEqual([`free-scan:req:${IP}`, `free-scan:ip:${IP}`]);
    expect(rateLimit).toHaveBeenCalledTimes(2);

    expect(response.status).toBe(429);
    expect(body.code).toBe("ip_capped");
    expect(runFraudScan).not.toHaveBeenCalled();
  });

  it("keys the per-IP counter off the trusted last X-Forwarded-For entry", async () => {
    // The spoofable prefix (198.51.100.7) must not reach the key, or an
    // attacker mints a fresh 3-scan allowance per request (issue #1361).
    rateLimit.mockResolvedValueOnce(allowed());
    rateLimit.mockResolvedValueOnce(exhausted());

    await POST(uploadRequest());

    // EVERY per-IP key, the request counter included: all of them are keyed
    // on the same address, so a spoofable prefix in any one of them is the
    // same bypass.
    const keys = rateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys[0]).toBe(`free-scan:req:${IP}`);
    expect(keys[1]).toBe(`free-scan:ip:${IP}`);
    for (const key of keys) expect(key).not.toContain("198.51.100.7");
  });

  it("answers an IP cap with signup-framed copy and a Retry-After", async () => {
    rateLimit.mockResolvedValueOnce(allowed());
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(typeof body.message).toBe("string");
    expect(body.message).toMatch(/sign|account/i);
    expect(typeof body.resetAt).toBe("number");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers a site-wide cap with site_capped after both tokens", async () => {
    // request: room, per-IP: room, site-wide: exhausted.
    rateLimit.mockResolvedValueOnce(allowed());
    rateLimit.mockResolvedValueOnce(allowed());
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(response.status).toBe(429);
    expect(body.code).toBe("site_capped");
    expect(rateLimit).toHaveBeenCalledTimes(3);
    expect(runFraudScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (h) The decode gate
// ---------------------------------------------------------------------------

describe("(h) an undecodable image consumes no SCAN token", () => {
  it("refuses with image_unreadable before either scan counter", async () => {
    // sharp's prebuilt binaries ship WITHOUT HEIF support, so a HEIC (and a
    // truncated JPEG, and a PDF renamed to image/png) returns null here and
    // would reach no Anthropic API at all. Without this gate every one of
    // those requests burns a site-wide token at zero cost to the sender — 30
    // of them is a free 24-hour denial of the landing page's primary CTA.
    prepareImage.mockResolvedValue(null);

    const response = await POST(
      uploadRequest({ name: "photo.heic", type: "image/heic" }),
    );
    const body = (await response.json()) as FreeScanBody;

    expect(response.status).toBe(415);
    expect(body.code).toBe("image_unreadable");
    // The COARSE REQUEST COUNTER IS CONSUMED — that is the security fix
    // (resource-bound-placement): the decode itself is now priced, so an
    // attacker cannot force unlimited 4 MB sharp decodes for free. What must
    // still cost nothing is the SCAN ALLOWANCE, because HEIC uploads from
    // mobile traffic are expected and a visitor who sends one has to be able
    // to retry with a JPEG.
    const keys = rateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys).toEqual([`free-scan:req:${IP}`]);
    expect(keys).not.toContain(`free-scan:ip:${IP}`);
    expect(keys).not.toContain("free-scan:global");
    expect(runFraudScan).not.toHaveBeenCalled();
  });

  it("tells the visitor how to fix it rather than reporting an error", async () => {
    prepareImage.mockResolvedValue(null);

    const response = await POST(
      uploadRequest({ name: "photo.heic", type: "image/heic" }),
    );
    const body = (await response.json()) as FreeScanBody;

    expect(body.message).toMatch(/JPEG|PNG/);
  });
});

// ---------------------------------------------------------------------------
// (i) The decode itself is priced
//
// Security finding `resource-bound-placement`. The decode gate at step 5 runs
// ABOVE the two scan counters, and that ordering is deliberate: an undecodable
// image must not burn a scan allowance, because sharp's prebuilt binaries
// have no HEIF support and HEIC uploads from mobile traffic are EXPECTED, not
// abusive. The consequence was that the sharp decode was entirely free and
// unmetered — an attacker could force repeated 4 MB decodes without consuming
// any counter at all. `limitInputPixels` bounds each individual decode, so it
// was never unbounded; it was simply unpriced.
//
// The fix is a THIRD counter, coarse and separate: 20 requests per hour per
// IP, consumed after the cheap validation (API key, zod, MIME, size) but
// BEFORE prepareImage. 20 rather than 3 so a real visitor who retries a HEIC,
// exports a JPEG, and then scans a second document never meets it.
//
// WHY ORDERING IS THE WHOLE PROPERTY: rateLimit() has no peek, so "the decode
// was priced" is not observable from any response field. It is observable only
// as the relative order of two mock invocations, which is what the first two
// assertions below read.
// ---------------------------------------------------------------------------

describe("(i) the sharp decode is metered by a per-IP request counter", () => {
  it("consumes the request counter before the decode", async () => {
    await POST(uploadRequest());

    // invocationCallOrder is a global monotonic counter shared across vitest
    // mocks, so this compares the limiter call against the decode call
    // directly. Move the counter below prepareImage in the route and this is
    // the assertion that reports it.
    expect(rateLimit).toHaveBeenCalled();
    expect(prepareImage).toHaveBeenCalled();
    expect(rateLimit.mock.invocationCallOrder[0]).toBeLessThan(
      prepareImage.mock.invocationCallOrder[0],
    );
  });

  it("never reaches the decode once the request counter is exhausted", async () => {
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    // THE POINT OF THE FIX. If prepareImage still runs here, the attacker
    // still gets the CPU for free and the counter bought nothing.
    expect(prepareImage).not.toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(body.code).toBe("too_many_requests");
    expect(runFraudScan).not.toHaveBeenCalled();
  });

  it("charges no scan allowance when the request counter refuses", async () => {
    rateLimit.mockResolvedValueOnce(exhausted());

    await POST(uploadRequest());

    // A request-rate refusal must not cost the visitor one of their 3 scans
    // or the site one of its 30. The keys are the only observable form this
    // guarantee has.
    const keys = rateLimit.mock.calls.map((c) => c[0] as string);
    expect(keys).toEqual([`free-scan:req:${IP}`]);
    expect(keys).not.toContain(`free-scan:ip:${IP}`);
    expect(keys).not.toContain("free-scan:global");
    expect(rateLimit).toHaveBeenCalledTimes(1);
  });

  it("uses a distinct code, not one of the three cap codes", async () => {
    // decideFreeScanCap owns ip_capped / site_capped / cap_unavailable and
    // answers the question "has this caller used up its SCANS". This counter
    // answers a different question, so it must not borrow those codes: the
    // client copy for ip_capped tells the visitor they have used all 3 free
    // scans, which would be a lie here.
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.code).toBe("too_many_requests");
    expect(body.code).not.toBe("ip_capped");
    expect(body.code).not.toBe("site_capped");
    expect(body.code).not.toBe("cap_unavailable");
  });

  it("emits Retry-After when the window reset time is known", async () => {
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());

    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("omits Retry-After when the window reset time is unknown", async () => {
    rateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      enforcement: "memory_unconfigured",
      resetAt: null,
    });

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(body.code).toBe("too_many_requests");
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("keys the request counter off the trusted last X-Forwarded-For entry", async () => {
    rateLimit.mockResolvedValueOnce(exhausted());

    await POST(uploadRequest());

    // Same bypass as the scan counter (issue #1361): read the raw header and
    // an attacker mints a fresh 20-request budget per request, which puts the
    // decode back to being free.
    expect(rateLimit.mock.calls[0][0]).toBe(`free-scan:req:${IP}`);
    expect(rateLimit.mock.calls[0][0]).not.toContain("198.51.100.7");
  });

  it("is not consulted by refusals that are cheaper than it", async () => {
    // The counter sits BELOW the cheap checks, so a 4 MB text/plain upload is
    // still rejected without touching any counter at all. Hoisting it above
    // the MIME and size gates would make those refusals consume budget, and
    // the cheap gates are exactly the ones that should be free.
    const response = await POST(
      uploadRequest({ name: "notes.txt", type: "text/plain" }),
    );

    expect(response.status).toBe(415);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(prepareImage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The route must stay out of the entitlement machinery
// ---------------------------------------------------------------------------

/**
 * Identifiers and string literals that appear in CODE, with comments and
 * whitespace discarded.
 *
 * Parsed rather than grepped, for the same reason
 * tests/entitlement-select-coverage.test.ts parses: a plain text match cannot
 * tell a call from a sentence, so it forbids the route from DOCUMENTING what
 * it deliberately does not do. That was not hypothetical — the first version
 * of this assertion failed on the route's own header comment explaining why
 * `computeQuota` is absent. Both of those suites walk the AST too, which is
 * why a comment here cannot opt this file into them either.
 */
function codeSymbols(source: string): {
  identifiers: Set<string>;
  literals: Set<string>;
} {
  const sf = ts.createSourceFile(
    "route.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const identifiers = new Set<string>();
  const literals = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    else if (ts.isStringLiteral(node)) literals.add(node.text);
    ts.forEachChild(node, walk);
  };
  walk(sf);
  return { identifiers, literals };
}

describe("the anonymous route reads no user state", () => {
  const source = readFileSync(
    path.resolve(__dirname, "..", "src/app/api/free-scan/route.ts"),
    "utf8",
  );
  const { identifiers, literals } = codeSymbols(source);

  it("parses the route, so the assertions below cannot pass vacuously", () => {
    // A broken walk or a parse failure yields empty sets, and every
    // `not.toContain` below would then pass on a route that does every one of
    // the things they forbid.
    expect(identifiers).toContain("runFraudScan");
    expect(identifiers).toContain("prepareImage");
    expect(identifiers).toContain("rateLimit");
  });

  it("does not query subscriptions or compute a user quota", () => {
    // An IP cap is not a user quota. Touching `subscriptions`, `computeQuota`
    // or `scanWindowStart` would also opt this file into two
    // filesystem-walking contract suites that exist to govern the
    // authenticated path (tests/entitlement-select-coverage.test.ts,
    // tests/single-clock-per-quota-decision.test.ts).
    expect(literals).not.toContain("subscriptions");
    expect(identifiers).not.toContain("computeQuota");
    expect(identifiers).not.toContain("scanWindowStart");
    expect(identifiers).not.toContain("createServerSupabaseClient");
  });

  it("fires no analytics and makes no second AI call", () => {
    // Analytics is the client's job here: a server-side emit would attribute
    // an anonymous scan to a server distinct id, and `activate` must never
    // fire for a visitor who has not signed up.
    expect(identifiers).not.toContain("trackServerEvent");
    expect(identifiers).not.toContain("trackPaywallShown");
    expect(literals).not.toContain("activate");
    // runFraudScan already makes exactly one content pass; a direct call here
    // as well would double the per-visitor cost and halve both caps.
    expect(identifiers).not.toContain("analyzeDocumentForFraud");
  });
});

// ---------------------------------------------------------------------------
// The response type is tight enough to catch a wrong comparison
// ---------------------------------------------------------------------------

/**
 * WHY THIS IS A TEST AND NOT JUST A TYPE.
 *
 * `vision_status` was declared `string` even though it is always
 * `vision.status`, the VisionStatus union ("analyzed" / "inconclusive" /
 * "unavailable"). That looseness already produced a real defect: the plan for
 * the free-scan panel specified branching on `vision_status !== "ok"`, and
 * "ok" is not a member of the union — so the comparison is true for EVERY
 * scan, including a fully analyzed one, and the panel would have stamped
 * "Partial analysis" on every success. Against `string`, tsc has nothing to
 * say about it. Against the union, `!== "ok"` is a compile error.
 *
 * It was caught by a human reading the type. This suite is so that the next
 * one is caught by the compiler, and so that widening the field back to
 * `string` is a failing test rather than an invisible edit.
 */
describe("the exported response type pins vision_status to the vision union", () => {
  const source = readFileSync(
    path.resolve(__dirname, "..", "src/app/api/free-scan/route.ts"),
    "utf8",
  );
  const sf = ts.createSourceFile(
    "route.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  /** The declared type of one member of the FreeScanResponse type alias. */
  function memberType(name: string): string | undefined {
    let found: string | undefined;
    const walk = (node: ts.Node): void => {
      if (
        ts.isTypeAliasDeclaration(node) &&
        node.name.text === "FreeScanResponse" &&
        ts.isTypeLiteralNode(node.type)
      ) {
        for (const member of node.type.members) {
          if (
            ts.isPropertySignature(member) &&
            member.name &&
            ts.isIdentifier(member.name) &&
            member.name.text === name &&
            member.type
          ) {
            found = member.type.getText(sf);
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return found;
  }

  it("parses FreeScanResponse, so the assertion below cannot pass vacuously", () => {
    // A parse failure or a renamed alias yields undefined for every member,
    // and an assertion written as a not-equals would then pass on anything.
    expect(memberType("score")).toBe("number");
    expect(memberType("total_signal_count")).toBe("number");
  });

  it("types vision_status as VisionStatus, not string", () => {
    expect(memberType("vision_status")).toBe("VisionStatus");
  });

  it("imports that type from lib/fraud/vision, where the union is declared", () => {
    expect(source).toMatch(
      /import\s+type\s*\{[^}]*\bVisionStatus\b[^}]*\}\s*from\s*"@\/lib\/fraud\/vision"/,
    );
  });

  // NOT ASSERTED HERE: that the literal "ok" is absent from the route. It is
  // legitimately present and means something else entirely — "ok" is a member
  // of FreeScanCapCode, and `cap.code !== "ok"` at step 9 is correct. The two
  // vocabularies collide on one word, which is part of why the vision_status
  // mistake was easy to make. The type above is the guard; a literal ban
  // would only forbid the cap check.
});
