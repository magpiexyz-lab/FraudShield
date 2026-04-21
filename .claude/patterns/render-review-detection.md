# Render-Review Detection

Detection procedure for agents that navigate auth-gated routes in demo mode
and must distinguish a real render from a redirect / skeleton / navigation
failure. Prevents per-page reviewers from silently issuing `pass` verdicts
when the target page was never actually rendered.

> Called by:
> - `.claude/procedures/design-critic.md` (per page, before screenshot)
> - `.claude/procedures/accessibility-scanner.md` (per page, inside R1 loop)

## Inputs

Caller passes an options object to the inline detection script:

- `requested_route`: path being reviewed (e.g. `"/dashboard"`)
- `base_url`: dev server URL the caller already started (e.g. `"http://localhost:3099"`)
- `is_first_page`: boolean — when `true` and URL bypass fails into an auth
  route, the detection marks `fallback_reason="demo-mode-bypass-failed"` so
  the loud upstream middleware/env bug surfaces exactly once per run.

## Outputs

Returned as a JS object. The caller merges it into the agent's trace.

- `review_method`: `"rendered-authed" | "rendered-demo" | "source-only" | "unknown"`
- `review_evidence`:
  - `requested_route`: string (echo of input)
  - `final_url`: string (`page.url()` after settle)
  - `auth_source`: `"storageState" | "demo-mode" | null`
  - `fallback_reason`: string | null (e.g. `"redirected-to-auth-route"`,
    `"demo-mode-bypass-failed"`, `"storageState-load-failed"`, `"auth.json-no-cookies"`)
  - `content_density`: number | null (observational only; NOT gated in this change)

## Section 1 — storageState injection (optional, non-fatal)

Before creating a BrowserContext, try to load `e2e/.auth.json` and validate it
as Playwright-compatible storageState with a real Supabase session:

```javascript
const fs = require("fs");
const AUTH_FILE = "e2e/.auth.json";

function tryLoadStorageState() {
  if (!fs.existsSync(AUTH_FILE)) return { ok: false, reason: "auth.json-absent" };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return { ok: false, reason: "auth.json-parse-failed" };
  }
  if (!Array.isArray(data.cookies) || data.cookies.length === 0) {
    return { ok: false, reason: "auth.json-no-cookies" };
  }
  if (!data.cookies.some((c) => /^sb-.*-auth-token/.test(c.name || ""))) {
    return { ok: false, reason: "auth.json-no-supabase-cookie" };
  }
  return { ok: true };
}
```

Create context with shape guard. If `newContext({storageState})` throws
(custom shape, missing `origins`, etc.), fall back to a plain context:

```javascript
let authSource = "demo-mode";
let fallbackReason = null;
let context;
const storageStateCheck = tryLoadStorageState();
if (storageStateCheck.ok) {
  try {
    context = await browser.newContext({ storageState: AUTH_FILE });
    authSource = "storageState";
  } catch (err) {
    context = await browser.newContext();
    fallbackReason = "storageState-load-failed";
  }
} else {
  context = await browser.newContext();
  fallbackReason = storageStateCheck.reason; // observational; demo-mode still proceeds
}
```

## Section 2 — Navigate with settle wait

`networkidle` alone is not enough — client-side `useEffect` auth redirects
may fire after networkidle settles. Wait 500 ms extra before reading the URL:

```javascript
const page = await context.newPage();
let navError = null;
try {
  await page.goto(base_url + requested_route, { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(500);
} catch (err) {
  navError = err.message;
}
```

## Section 3 — Classify review_method

```javascript
const AUTH_PATHS = new Set(["/login", "/signup", "/auth/callback", "/auth/reset-password"]);
let reviewMethod;
let finalUrl = null;
let finalPath = null;

if (navError) {
  reviewMethod = "unknown";
  fallbackReason = `navigation-failed:${navError}`;
} else {
  finalUrl = page.url();
  try { finalPath = new URL(finalUrl).pathname; } catch { finalPath = null; }

  if (finalPath !== requested_route) {
    reviewMethod = "source-only";
    if (AUTH_PATHS.has(finalPath)) {
      fallbackReason = is_first_page ? "demo-mode-bypass-failed" : "redirected-to-auth-route";
    } else {
      fallbackReason = `redirected:${finalPath ?? "unknown"}`;
    }
  } else if (authSource === "storageState") {
    reviewMethod = "rendered-authed";
  } else {
    reviewMethod = "rendered-demo";
  }
}
```

Note: `auth.json-*` preconditions from Section 1 are INFORMATIONAL — they do
NOT force `review_method = "source-only"`. They only block claiming
`"rendered-authed"`. When cookies are absent we still review the page in
demo mode; that is normal for bootstrap.

## Section 4 — Content density (observational)

```javascript
let contentDensity = null;
if (reviewMethod === "rendered-demo" || reviewMethod === "rendered-authed") {
  try {
    contentDensity = await page.evaluate(() => {
      const sub = (sel) => document.querySelector(sel)?.innerText?.length ?? 0;
      const body = document.body?.innerText?.replace(/\s+/g, " ").trim().length ?? 0;
      return body - sub("header") - sub("nav") - sub("footer");
    });
  } catch {
    contentDensity = null;
  }
}
```

Not gated in this change. Surfaces in the trace for downstream analysis and
future tightening once real-data thresholds are known.

## Section 5 — Return shape

```javascript
return {
  review_method: reviewMethod,
  review_evidence: {
    requested_route,
    final_url: finalUrl,
    auth_source: authSource,
    fallback_reason: fallbackReason,
    content_density: contentDensity,
  },
  context,  // caller reuses this context for screenshot / axe scan
  page,
};
```

## Caller contract

- The caller owns the dev server (start + port + cleanup) — this pattern
  never starts or stops a server.
- The caller decides what to do when `review_method ∈ {"source-only", "unknown"}`:
  - `design-critic`: still take the screenshot for evidence, skip Layers 1-3
    review, emit `verdict="unresolved"` with `caveat = fallback_reason`.
  - `accessibility-scanner`: skip axe-core scan for the page, do NOT count it
    in `pages_scanned`, do NOT emit violations for it.
- Set `is_first_page = true` only for the first auth-gated route per run so
  `demo-mode-bypass-failed` fires exactly once when the upstream bug is
  present.
