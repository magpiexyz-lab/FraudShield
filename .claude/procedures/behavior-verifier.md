# Behavior Verifier Procedure

> Executed by the behavior-verifier agent. See `.claude/agents/behavior-verifier.md` for identity, failure taxonomy, and output contract.

## Archetype Gate

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Spec field".
>
> web-app: golden_path | service: endpoints | cli: commands

Read `experiment/experiment.yaml` to determine the archetype (`type` field, default: `web-app`). For web-app: also read `golden_path`. For service: read `endpoints` and optionally `golden_path` (if present). For cli: read `commands` and optionally `golden_path` (if present).

---

## Procedure: web-app

### Production Mode Detection

Before starting any steps, check for production mode:

- If `E2E_BASE_URL` environment variable is set: **production mode** is active.
  - `BASE_URL` = value of `E2E_BASE_URL`
  - Read `.runs/prod-test-credentials.json` if it exists — use `email` and `password` fields for any login steps
  - Use `captureAnalytics(page)` instead of `blockAnalytics(page)` — validates that production analytics wiring fires correctly while intercepting requests (prevents pollution)
  - Skip behaviors with `trigger: stripe webhook` — classify as `skipped` with reason "stripe webhook trigger skipped in production mode"
- If `E2E_BASE_URL` is NOT set: **local mode** (existing behavior unchanged).
  - `BASE_URL` = `http://localhost:3097`

### 1. Prerequisite

Run `npx playwright --version`. If it fails, return:
> Skipping behavior verification — Playwright not installed.

### 2. Start Server

**Production mode** (`E2E_BASE_URL` set): SKIP server start entirely. The production server is already running. Verify reachability:
```bash
curl -s -o /dev/null -w "%{http_code}" "$E2E_BASE_URL"
```
If not HTTP 200, abort: "Production server at $E2E_BASE_URL is unreachable (HTTP <code>)."

**Local mode** (`E2E_BASE_URL` not set):
```bash
DEMO_MODE=true NEXT_PUBLIC_DEMO_MODE=true npm run start -- -p 3097 &
```

Poll `http://localhost:3097` until it responds (max 15 seconds, then abort).

### 3. Walk Golden Path (State Machine)

Write an inline Playwright script that walks each `golden_path` step **in a single browser context** — never create a fresh context between steps. The golden path is a connected journey; state must carry forward.

Read `experiment/experiment.yaml` `golden_path` and `behaviors` to determine inputs, expected outcomes, and state transitions for each step.

**Production mode adjustments:**
- Use `E2E_BASE_URL` as the base URL for all `page.goto()` calls instead of `http://localhost:3097`
- **Auth handling**: If `.runs/prod-test-credentials.json` exists, use those credentials (`email` and `password` fields) for any login step. Use the same `login()` pattern from `e2e/helpers.ts` (fill email, fill password, click submit, wait for redirect).
- **Analytics**: Use `captureAnalytics(page)` instead of `blockAnalytics(page)` — this validates that production analytics wiring fires correctly while still intercepting requests (Playwright route interception prevents actual data from reaching the provider). In local mode, continue using `blockAnalytics(page)`.
- **Payment behaviors**: Skip behaviors with `trigger: stripe webhook` when in production mode — webhook simulation against production Stripe is out of scope. Classify these as `skipped` with reason "stripe webhook trigger skipped in production mode".
- **Test data**: All test-generated data (form submissions, signups) is created under the production test user. No special prefix needed — RLS scopes data to the authenticated user.

#### Per-behavior render-review check (BEFORE running given/when/then probes)

For every behavior with an `entry_route`, verify the route is actually
reachable in the right auth state before running the behavioral probes.
This avoids verifying a behavior in demo mode when the spec says
"logged-in user" — that's a SKIP, not a FAIL.

Implementation pseudocode (Python in the inline Playwright script,
running once per behavior **at the start** of the step loop, before
the existing 5-step per-step probe sequence):

```python
# Single canonical phrase classifier — DO NOT inline phrases here.
from given_auth_matcher import requires_auth  # see .claude/patterns/given-auth-matcher.md

firstAuthGatedSeen = False
per_behavior_reviews = []
unmatched_phrases = []

for i, behavior in enumerate(behaviors):
    if not behavior.get("entry_route"):
        continue  # skip behaviors without a UI entry point

    auth = requires_auth(behavior.get("given") or "")
    auth_requirement = "required" if auth["result"] else "optional"
    if auth["unmatched"]:
        unmatched_phrases.append(behavior["given"])

    # firstAuthGatedSeen pattern (NOT i === 0); see render-review-detection.md
    isAuthGated = (auth_requirement == "required")
    is_first_page = isAuthGated and not firstAuthGatedSeen
    if isAuthGated:
        firstAuthGatedSeen = True

    # Call the wrapper (handles setup + navigate + classify in one go)
    result = render_review_detect(
        browser=browser,
        base_url=BASE_URL,
        requested_route=behavior["entry_route"],
        expected_destination=behavior["entry_route"],
        auth_requirement=auth_requirement,
        is_first_page=is_first_page,
    )
    review_method = result["review_method"]
    review_evidence = result["review_evidence"]

    # Map review_method -> per-behavior verdict (per the policy table in
    # .claude/agents/behavior-verifier.md). The shared
    # review-verdict-gate.md will auto-correct any verdict drift after
    # the trace lands.
    if review_method in ("rendered-authed", "rendered-demo"):
        verdict = "PASS"  # proceed with given/when/then probes (Steps 1-5 below)
        # ... (existing per-step probes go here)
    elif review_method == "prereq-unmet":
        verdict = "SKIPPED"  # session needed, not a failure
        # do NOT run probes
    elif review_method == "source-only":
        final_path = (review_evidence or {}).get("final_url", "")
        # AUTH_PATHS is the canonical set in render-review-detection.md
        if any(final_path.endswith(p) for p in AUTH_PATHS):
            verdict = "FAIL"  # B3 Silent Failure: auth-redirect on expected route
        else:
            verdict = "DEGRADED"  # product-level redirect (e.g., /pricing → /pricing/individual)
    else:  # "unknown"
        verdict = "FAIL"

    per_behavior_reviews.append({
        "behavior_id": behavior.get("id"),
        "given": behavior.get("given"),
        "requires_auth": auth["result"],
        "matched_phrase": auth["matched_phrase"],
        "unmatched_given_phrase": behavior["given"] if auth["unmatched"] else None,
        "review_method": review_method,
        "review_evidence": review_evidence,
        "verdict": verdict,
    })
```

The `per_behavior_reviews[]` array goes directly into the trace JSON
(see `.claude/agents/behavior-verifier.md` Trace Output). The
`unmatched_given_phrase` top-level diagnostic (first unmatched phrase
encountered) is also recorded so a maintainer can extend
`.claude/patterns/given-auth-matcher.md`.

#### Then per-step probes (existing 5-step sequence, unchanged)

For each step (only when the behavior's pre-check returned `PASS` above):

1. **Navigate/interact** as specified by the golden path
2. **Capture evidence**: screenshot to `/tmp/behavior-verify/<step-N>.png`, current URL, HTTP status, all console errors/warnings
3. **Assert expected outcome**: correct redirect, success message, expected UI state
4. **Verification probe** (after critical mutations): make a second request to verify state persisted
   - After signup/login: reload page, verify session holds (not redirected to login)
   - After form submit: navigate to list/detail view, verify item appears
   - After settings change: reload, verify setting persists
5. **Classify result**: pass / FAIL [B1-B6] / degraded / skipped

### 4. Error Paths

For each page with a form, test **one invalid input**:
- Submit empty required field, or malformed email, or out-of-range value
- Assert: validation error shown (field-specific, not generic crash), no 500, form still usable after error

### 5. Quality Gate

- Happy path + 1 error path per form page.
- Also test edge cases — special characters in text inputs (`<script>`, unicode), very long text (>1000 chars), boundary values for numeric inputs, rapid double-submit on forms.

### 6. System Behavior Smoke

For `behaviors` with `actor: system` or `actor: cron`:
- Do NOT simulate triggers (cron jobs, webhooks)
- Verify handler exists: grep for the route/function
- If it's an API endpoint: POST with empty body → expect 400 or 401 (not 500 or 404)
- Classify: pass (handler exists + responds) / FAIL [B1] (500 or 404) / skipped (no endpoint to probe)

### 7. Cleanup

**Production mode** (`E2E_BASE_URL` set): Skip `kill %1` (no server to kill). Only clean up screenshots:
```bash
rm -rf /tmp/behavior-verify
```

**Local mode** (`E2E_BASE_URL` not set):
```bash
kill %1 2>/dev/null || true
rm -rf /tmp/behavior-verify
```

---

> **Production mode for service/cli archetypes:** The service procedure supports production mode — when `E2E_BASE_URL` is set, use it as the API base URL instead of `http://localhost:3097` in curl commands, and skip server start/kill. CLI archetypes do not support production mode (they test the local binary).

## Procedure: service

### 1. Start Server

**Production mode** (`E2E_BASE_URL` set): SKIP server start. Use `E2E_BASE_URL` as the API base URL for all curl commands. Verify reachability with `curl -s -o /dev/null -w "%{http_code}" "$E2E_BASE_URL/api/health"`.

**Local mode** (`E2E_BASE_URL` not set):
Start the server using the project's start command on port 3097.

### 2. Walk API Flow (State Machine)

If `golden_path` exists in experiment.yaml, walk each `golden_path` step and test the corresponding API endpoint **sequentially** — responses from step N inform requests to step N+1 (e.g., auth token from login used in subsequent requests).

If `golden_path` does not exist (surface-less service), walk each entry in `endpoints` from experiment.yaml as a sequential API flow instead.

For each step:

1. **Send request** via `curl` with appropriate method, headers, body
2. **Capture evidence**: full response (status + headers + body), expected vs actual
3. **Assert outcome**: correct status code, response shape matches expected structure, state mutation verifiable
4. **Verification probe**: after mutations, read back the data (GET after POST/PUT) to confirm persistence
5. **Classify result**: pass / FAIL [B1-B6] / degraded / skipped

### 3. Error Paths

For each endpoint:
1. **Invalid input** → assert 4xx (not 500), error message is descriptive and field-specific
2. **Missing/invalid auth** (if auth exists) → assert 401 or 403 (not 200 or 500)

### 4. Quality Gate

- Happy path + 1 invalid input per endpoint.
- Also test missing fields, wrong types, boundary values, empty arrays vs null.

### 5. System Behavior Smoke

Same as web-app: verify handlers exist for system/cron behaviors, probe endpoints.

### 6. Cleanup

Kill the server process.

---

## Procedure: cli

### 1. Build

Run the project's build command to produce the CLI binary/entry point.

### 2. Walk Golden Path (State Machine)

For each `golden_path` step:

1. **Run command** with specified arguments
2. **Capture evidence**: exit code, full stdout, full stderr
3. **Assert outcome**: exit code 0, expected output contains key content, side effects verifiable (files created, output written)
4. **Verification probe**: after mutations (file create, config write), verify the artifact exists and contains expected content
5. **Classify result**: pass / FAIL [B1-B6] / degraded / skipped

### 3. Error Paths

For each command:
1. **Invalid args** → assert non-zero exit code, human-readable error message (not stack trace)
2. **Missing required args** → assert non-zero exit code, usage hint shown

### 4. Quality Gate

- Happy path + 1 invalid arg per command.
- Also test missing required args, conflicting flags, edge case inputs (empty string, very long args, special characters).
