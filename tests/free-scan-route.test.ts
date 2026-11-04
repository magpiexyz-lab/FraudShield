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
  signals?: FraudSignal[];
  total_signal_count?: number;
  usage?: { input_tokens: number; output_tokens: number; model: string };
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

  it("consumes exactly two tokens: per-IP then site-wide, in that order", async () => {
    await POST(uploadRequest());

    expect(rateLimit).toHaveBeenCalledTimes(2);
    expect(rateLimit.mock.calls[0]).toEqual([`free-scan:ip:${IP}`, 3, 86400]);
    expect(rateLimit.mock.calls[1]).toEqual(["free-scan:global", 30, 86400]);
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
    expect(body.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 300,
      model: "claude-opus-5",
    });
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
    // No call reached the model, so there is nothing to report as billed.
    expect(body.usage).toBeUndefined();
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
    expect(keys).toEqual([`free-scan:ip:${IP}`]);
    expect(rateLimit).toHaveBeenCalledTimes(1);

    expect(response.status).toBe(429);
    expect(body.code).toBe("ip_capped");
    expect(runFraudScan).not.toHaveBeenCalled();
  });

  it("keys the per-IP counter off the trusted last X-Forwarded-For entry", async () => {
    // The spoofable prefix (198.51.100.7) must not reach the key, or an
    // attacker mints a fresh 3-scan allowance per request (issue #1361).
    rateLimit.mockResolvedValueOnce(exhausted());

    await POST(uploadRequest());

    expect(rateLimit.mock.calls[0][0]).toBe(`free-scan:ip:${IP}`);
    expect(rateLimit.mock.calls[0][0]).not.toContain("198.51.100.7");
  });

  it("answers an IP cap with signup-framed copy and a Retry-After", async () => {
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(typeof body.message).toBe("string");
    expect(body.message).toMatch(/sign|account/i);
    expect(typeof body.resetAt).toBe("number");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("answers a site-wide cap with site_capped after both tokens", async () => {
    rateLimit.mockResolvedValueOnce(allowed());
    rateLimit.mockResolvedValueOnce(exhausted());

    const response = await POST(uploadRequest());
    const body = (await response.json()) as FreeScanBody;

    expect(response.status).toBe(429);
    expect(body.code).toBe("site_capped");
    expect(rateLimit).toHaveBeenCalledTimes(2);
    expect(runFraudScan).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (h) The decode gate
// ---------------------------------------------------------------------------

describe("(h) an undecodable image consumes no global token", () => {
  it("refuses with image_unreadable before either counter", async () => {
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
    expect(rateLimit).not.toHaveBeenCalled();
    const keys = rateLimit.mock.calls.map((c) => c[0] as string);
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
