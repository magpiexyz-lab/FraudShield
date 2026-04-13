# Wire Procedure

## Prerequisites
- Scaffold phase completed (project structure exists, Merged Checkpoint passed)
- `.runs/current-plan.md` exists
- Scaffold subagent's completion report (external dep decisions) provided in your prompt
- Read all context files listed in your task assignment before starting

## Steps

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.

### Step 5: API routes

If the archetype is `cli`: skip this step entirely — CLIs have no API routes or hosting stack.

- Create the API routes directory per the framework stack file
- Create `/api/health` endpoint per the hosting stack file's Health Check template. Add service-specific checks based on active stack: database connectivity check when `stack.database` is present, auth service check when `stack.auth` is present, analytics reachability check when `stack.analytics` is present, payment config check when `stack.payment` is present.
- If experiment.yaml behaviors imply mutations (creating records, payments, etc.), create corresponding API route handlers. If `stack.payment` is present: for payment routes, use the templates from the payment stack file's "API Routes" section — these include auth-integration checks and webhook signature verification patterns that must not be omitted.
- For the webhook handler's `// TODO: Update user's payment status in database` comment: resolve it using the database schema you planned in Phase 1. If no payments/subscriptions table was planned, add one to the migration in Step 6 and return here to wire the webhook update after the table exists.
- Every API route: validate input with zod, return proper HTTP status codes. If `stack.database` is present, use the server-side database client for data access.
- For routes with dynamic segments (e.g., `[id]`), validate path params with zod before use: `const { id } = z.object({ id: z.string().uuid() }).parse(await params)`. Return 400 for invalid params. This prevents malformed path values from reaching database queries.
- Export Zod request schemas from route files with `export const` using the naming convention `<verb><Resource>Schema` (e.g., `export const createInvoiceSchema = z.object({...})`). For response shapes, export a plain TypeScript type or interface (e.g., `export type CreateInvoiceResponse = { id: string; sendLink: string }`). Request schemas need Zod (they validate untrusted input). Response types are plain TS (server-authored, not validated). These exports enable Step 6 to collect API contract types into `types.ts`.
- Follow the hosting stack file for rate limiting guidance in auth and payment API route handlers. Mention any limitations in the PR body so the user knows to address them before production

#### Provision-at-deploy routes

For each core dependency marked "Provision at deploy" in Step 4b: create the full API route implementation referencing env vars from `.env.example`. Guard against missing credentials at runtime:

```typescript
if (!process.env.SERVICE_API_KEY) {
  console.error(`[503] [name] not configured — run /deploy to provision credentials`);
  return NextResponse.json(
    { error: "Service not configured" },
    { status: 503 }
  );
}
```

These routes must:
- Compile and pass `npm run build` without real credentials present
- Return 503 with generic error message when env vars are missing (service details logged server-side only — see security-review.md A4)
- Implement the complete integration logic (OAuth flow, API calls, etc.) when env vars are present
- Read the external stack file (`.claude/stacks/external/<service-slug>.md`) for API patterns and code templates

### Step 5b: Auth infrastructure files (if `stack.auth` is present)

Create auth infrastructure files not owned by scaffold-libs or scaffold-pages:

1. **Auth callback route** (`src/app/auth/callback/route.ts`): from auth stack file's callback handler template. Use shared-client or standalone-client variant based on whether `stack.database` matches the auth provider.
2. **Reset password page** (`src/app/auth/reset-password/page.tsx`): from auth stack file's reset password template.
3. **Auth-aware nav bar** (`src/components/nav-bar.tsx`): from auth stack file's NavBar template. Replace `APP_NAME` with experiment.yaml `name`. Add nav links for each golden_path page (excluding landing and auth routes).

These files depend on auth library files (scaffold-libs, B1) and are referenced by pages (scaffold-pages, B2). Creating them in the wire phase ensures all dependencies exist.

### Step 6: Database schema (if needed)
If `stack.database` is present and experiment.yaml behaviors require persistent data:
- Follow the schema management approach from the database stack file
- Create the initial migration with all tables needed for experiment.yaml behaviors. Migration numbering is based on the current branch state — concurrent branches may create conflicting numbers, which should be resolved by renumbering at merge time.
- If `stack.payment` is present and a payments/subscriptions table was created: return to the webhook handler (`src/app/api/webhooks/stripe/route.ts`) and resolve the `// TODO: Update user's payment status in database` using the new table before proceeding to Step 7.
- If `stack.email` is present and the nudge route requires activation tracking: add `activated_at timestamptz` and `nudge_sent_at timestamptz` columns to the user-related table (or create a `user_status` table if no user table exists beyond Supabase auth). The nudge cron queries this to find un-activated, un-nudged users.
- Also create `src/lib/types.ts` with:
  - **Database row types** matching table schemas, using `XxxRow` naming (e.g., `InvoiceRow`, `UserRow`)
  - **API contract types** imported from the Zod schemas and response types exported by route files in Step 5. For request types: `import { createInvoiceSchema } from "@/app/api/invoices/route"` then `export type CreateInvoiceRequest = z.infer<typeof createInvoiceSchema>`. For response types: re-export directly (e.g., `export type { CreateInvoiceResponse } from "@/app/api/invoices/route"`). Naming convention: `XxxRequest` for request bodies, `XxxResponse` for response shapes.
  - Dependency direction: `route.ts` ← `types.ts` ← `page.tsx`. Routes export schemas but never import from `types.ts`. Pages import types from `types.ts`, never from route files directly. This keeps the dependency graph acyclic.
- Include post-merge database setup instructions in the PR body (see database stack file's "PR Instructions" section)

If no behaviors require database tables, skip this step.

### Step 7: Environment config
- Generate `.env.example` by combining all environment variables from active stack files (framework, database, analytics, images, and any others that define env vars)
- Always include `FAL_KEY` in `.env.example` for web-app archetypes with a comment: `# AI image generation via fal.ai (optional -- SVG placeholders used if absent)`. Read `.claude/stacks/images/fal.md` for the env var name and format. The key is optional — bootstrap generates SVG placeholders when absent.

### Step 7b: Test scaffolding (if stack.testing is present)

If `stack.testing` is present in experiment.yaml:
- Read the testing stack file at `.claude/stacks/testing/<value>.md`
- Read the archetype file at `.claude/archetypes/<type>.md` to determine the archetype

**Compatibility check:**
- If archetype is `service` or `cli` and `stack.testing` is `playwright`: stop with error — "Playwright requires a browser and is not compatible with the `<archetype>` archetype. Use `testing: vitest` instead."
- If archetype is `web-app` and `stack.testing` is `vitest`: warn — "Vitest does not provide page-load testing for web apps. Proceeding, but consider using `testing: playwright` for browser-based smoke tests." Then proceed.

**If archetype is `web-app`:**
- Check assumes: for each `category/value` in the testing stack file's `assumes` list, verify
  it matches experiment.yaml `stack`. If all match → use full templates. If any unmet → use No-Auth
  Fallback templates.
- Install packages: `npm install -D @playwright/test && npx playwright install chromium`
- If using the full-auth path: install Supabase CLI (`npm install -D supabase`) and if
  `supabase/config.toml` does not exist, run `npx supabase init`
- Create files per the chosen template path:
  - `playwright.config.ts` (full or no-auth)
  - `e2e/helpers.ts` (full or no-auth)
  - If full-auth path: `e2e/global-setup.ts` and `e2e/global-teardown.ts`
- Generate `e2e/smoke.spec.ts` with one page-load test per experiment.yaml page:
  ```ts
  test("[page name] loads", async ({ page }) => {
    await page.goto("/[route]");
    await expect(page).toHaveTitle(/.+/);
  });
  ```
  These are page-load smoke tests only — not full funnel tests with selectors.
- If experiment.yaml has `variants`, also generate a smoke test per variant route:
  ```ts
  test("variant [slug] loads", async ({ page }) => {
    await page.goto("/v/[slug]");
    await expect(page).toHaveTitle(/.+/);
  });
  ```
- If `stack.testing` is present, generate `e2e/funnel.spec.ts` with a comprehensive funnel test:
  - Read the funnel test template from the testing stack file
  - If experiment.yaml has `golden_path`: use it as the funnel sequence. Each step with an `action` becomes a test step. Read actual page source files for selectors. Steps marked as activation points get an additional assertion that the action produces a visible result (not just page load).
  - If experiment.yaml has no `golden_path`: fall back to reading experiment.yaml pages and experiment/EVENTS.yaml to determine funnel sequence
  - Read actual page source files (created in Step 4) to extract real selectors
  - Generate tests: landing content → activate action (if applicable) → login → core value pages
  - For landing page CTA and success-message selectors, use `.first()` — the CTA appears at least twice on landing pages (messaging.md Section B), so selectors will match 2+ elements. Other pages have unique selectors and don't need `.first()`.
  - Use timestamped emails for form submissions to avoid duplicates
  - Skip retain_return (untestable in E2E)
- If `stack.testing` is present and experiment.yaml has `behaviors` with `tests` entries, generate `e2e/behaviors.spec.ts`:
  - Read the behaviors test template from the testing stack file
  - For each behavior with `actor: user` (or `actor` absent — default is user):
    - Create a `test.describe` block labeled `"<id>: <when clause summary>"`
    - Determine auth requirement from `given` field: phrases like "logged-in user", "authenticated user", "user on dashboard" → add `test.use({ storageState: "e2e/.auth.json" })`. Otherwise → anonymous (no storageState).
    - For each entry in `behavior.tests` array: create a `test()` case with the entry as the test name
    - Read actual page source (from the page associated with the behavior's golden_path step or from the behavior's `given`/`when` context) to extract real Playwright selectors
    - **Assertion depth**: Read the behavior's `then` clause to determine assertion pattern. Every `test()` must include at least one assertion beyond `toBeVisible()`:
      - `then` contains "created"/"generated" → assert content/data exists (`toContainText`, `toHaveText`)
      - `then` contains "redirected"/"navigates"/"land on" → assert URL change (`toHaveURL`)
      - `then` contains "updates"/"changes"/"marked" → assert visible state change (before/after)
      - `then` contains "shows"/"displays"/"renders" → assert actual data values, not just presence
      - `then` contains "accepts"/"validates" → verify input processing (fill → submit → verify result)
      - Default → interact per `when` clause, then assert visibility on outcome
      This refines existing `behaviors[].tests` assertions — it does NOT create additional tests. See the testing stack file's "Assertion Depth Patterns" section for Playwright-specific examples.
  - Skip behaviors with `actor: system` or `actor: cron` (covered by `tests/flows.test.ts`)
  - Group anonymous behaviors first, then auth-gated behaviors (for readability)
- Add `.gitignore` entries per testing stack file
- Add `test:e2e` and `test:e2e:ui` scripts to `package.json`
- If the existing CI e2e job in `.github/workflows/ci.yml` does not match the chosen
  template path (full-auth vs. no-auth fallback), replace the `e2e:` job with the
  testing stack file's correct CI Job Template for that path.
- Add env vars from testing stack file to `.env.example` (based on chosen template path)

**If archetype is `service`:**
- Install vitest packages: `npm install -D vitest @vitest/coverage-v8`
- Create `vitest.config.ts` per the testing stack file's "Files to Create" section
- Generate `tests/smoke.test.ts` per the testing stack file's "Bootstrap Smoke Tests > Service Smoke Tests" template:
  - Import `app` from `../src/index` (the framework's exported app instance)
  - Health check test: `app.request("/api/health")` → assert status 200
  - One test per experiment.yaml `endpoints` entry: `app.request("/api/<endpoint>")` → assert `not.toBe(500)`
  - POST endpoints use empty JSON body — verifies route registration, not input validation
  - For frameworks without an exported `app` instance or `app.request()` (e.g., Virtuals ACP, Next.js): use the testing stack file's fallback guidance — test handler functions directly by importing from the path defined by the framework stack file
- Add `test`, `test:watch`, and `test:coverage` scripts to `package.json`
- Add CI step per the testing stack file's "CI Integration" section

**If archetype is `cli`:**
- Install vitest packages: `npm install -D vitest @vitest/coverage-v8`
- Create `vitest.config.ts` per the testing stack file's "Files to Create" section
- Generate `tests/commands.test.ts` per the testing stack file's "Bootstrap Smoke Tests > CLI Smoke Tests" template:
  - Helper `runCli(args)` that runs `node dist/index.js ${args}` via `execSync`, returns `{ stdout, exitCode }`
  - `--version` test: assert exit 0 + semver pattern
  - `--help` test: assert exit 0 + "Usage:" in output
  - One test per experiment.yaml `commands` entry: `<command> --help` → assert exit 0 + command name in output
  - Note: requires `npm run build` first — CI runs build before test
- Add `test`, `test:watch`, and `test:coverage` scripts to `package.json`
- Add CI step per the testing stack file's "CI Integration" section

### Step 7c: System/cron behavior integration tests (if behaviors with `actor: system/cron` present in experiment.yaml)

If experiment.yaml has behaviors with `actor: system/cron`:
- If vitest is not already installed (check `package.json` devDependencies): install `vitest`
- Create `tests/flows.test.ts` with one test per system/cron behavior:
  - Each test calls the relevant API endpoint(s) with test payloads
  - **Invocation pattern** — use the framework's test client: `app.request()` for frameworks that export an app instance (e.g., Hono). For frameworks without `app.request()` (e.g., Next.js), import the handler directly from the route file (e.g., `import { POST } from "@/app/api/webhooks/stripe/route"`) and call it with `new Request()`. Never use `fetch("http://localhost:...")` — tests must run without a server via `npm test`.
  - Asserts the `verify` condition (database state, email queued, status updated)
  - Tests are independent — each sets up its own state and cleans up
- For webhook flows: call the webhook handler with a realistic test payload.
  Guard the test with a check for required env vars (skip if missing).
  If `stack.payment` is present: webhook tests must go beyond auth guard checks — assert the handler processes the payload (e.g., database state changes, status updates). This is required by CLAUDE.md Rule 4 ("No additional tests except for auth and payment flows").
- For admin flows: call the admin API handler directly (no browser).
- For cron flows: call the cron API handler directly.
- If `stack.payment` is present: also generate tests for payment API routes (checkout, portal) that verify the handler creates sessions/returns correct responses — not just auth guards. Auth and payment flows are the two exceptions to Rule 4's minimal testing policy.
- Add `test:flows` script to package.json: `vitest run tests/flows.test.ts`
- These tests are NOT run during bootstrap — only created (same as funnel tests)

If experiment.yaml has no behaviors with `actor: system/cron`: skip this step entirely.

NOTE: Tests are NOT run during bootstrap — only created

If `stack.testing` is NOT present in experiment.yaml: skip this step entirely.

### Step 8: Verify before shipping
> **Note:** This step is executed by the bootstrap lead, not this subagent.
> The lead has the Agent tool required to spawn parallel review subagents
> (design-critic, security-defender, security-attacker).

- Follow the FULL verification procedure in `.claude/patterns/verify.md`:
  1. Build & lint loop (max 3 attempts)
  2. Save notable patterns (if you fixed errors)
  3. Template observation review (ALWAYS — even if no errors were fixed)

### Step 8b: Spec compliance check

Re-read `.runs/current-plan.md` and `experiment/experiment.yaml` now. Verify each of these before proceeding to the PR:

**Archetype-specific structure checks:**
- If archetype requires `pages` (web-app): for each page in `pages`, confirm `src/app/<page-name>/page.tsx` exists (or root page for `landing`)
- If archetype requires `endpoints` (service): for each endpoint in `endpoints`, confirm the API route or handler exists at the path defined by the framework stack file (e.g., `src/routes/<endpoint>.ts` for Hono, `src/app/api/<endpoint>/route.ts` for Next.js, `src/handlers/<endpoint>.ts` for Virtuals ACP). Also verify the route is registered in the entry point (e.g., `app.route()` call in `src/index.ts` for Hono).
- If archetype requires `commands` (cli): for each command in `commands`, confirm `src/commands/<command-name>.ts` exists with a `register<CommandName>Command(program)` export, and verify it is registered in `src/index.ts` per the framework stack file

**Feature and analytics checks:**
- For each behavior in `behaviors`: confirm the implementation addresses it
- If `stack.analytics` is present: verify analytics per `patterns/analytics-verification.md`
- If surface ≠ none and archetype is `service`: confirm root route exists and returns HTML (Content-Type: text/html)
- If surface ≠ none and archetype is `cli`: confirm `site/index.html` exists
- If `stack.payment` is present: confirm the webhook handler does not contain `// TODO: Update user's payment status` (this compiles silently — verify it was resolved in Step 5/6)
- If `stack.email` is present: confirm `vercel.json` contains the cron config, email routes exist, and welcome email is wired to auth callback
- If Fake Door features exist: confirm Fake Door components exist, fire `activate` with `fake_door: true`, and render polished UI with a "coming soon" dialog
- If core "Provision at deploy" routes exist: confirm they compile without real credentials and return 503 with actionable error when env vars are missing

**API contract checks (if archetype is `web-app` or `service`):**
- For each API route that has an exported Zod schema: find all pages that call this route (grep for the fetch URL path). For each calling page, verify the request body construction matches the schema's field names and types. If any field name mismatch: fix the page to match the API route's schema.
- For each page that destructures an API response: verify the destructured fields match the API route's response type. If any field is missing or misnamed: fix the page.
- For each `router.push()` or `redirect()` call with query parameters: verify the target page reads matching parameter names from `searchParams`. If any parameter name mismatch: fix the calling page.
- Verify `src/lib/types.ts` includes both `XxxRow` database types and `XxxRequest`/`XxxResponse` API contract types for every route with an exported Zod schema.
- Source of truth: the API route's Zod schema is authoritative. When a mismatch is found, fix the consumer (page), not the contract (route).

**Test file existence check (if `stack.testing` present):**
- If archetype is `web-app`: confirm `e2e/smoke.spec.ts` exists
- If archetype is `service`: confirm `tests/smoke.test.ts` exists
- If archetype is `cli`: confirm `tests/commands.test.ts` exists

- If anything is missing, implement it now. Do not proceed with gaps.

### Step 9: Commit, push, open PR
> **Note:** This step is executed by the bootstrap lead, not this subagent.
- You are already on a feature branch (created in Step 0). Do not create another branch.
- Stage all new files and commit: "Bootstrap MVP scaffold from experiment.yaml"
- Push and open PR using the `.github/PULL_REQUEST_TEMPLATE.md` format:
  - **Summary**: plain-English explanation — "Full MVP scaffold generated from experiment.yaml" with key highlights
  - **How to Test**: "After merging: [If hosting is Vercel: 1) Import your repo at vercel.com/new, 2) Connect Supabase via the Vercel integration (vercel.com/integrations/supabase) — it walks you through creating a Supabase project; database migrations are applied automatically during the first build, [If stack.payment is present: add Stripe env vars manually in Vercel Project → Settings → Environment Variables,] 3) Verify: visit your production URL and check each page] [If hosting is not Vercel: read the hosting stack file's PR Instructions for deployment steps] [If archetype is CLI: run `npm run build && node dist/index.js --help` to verify the CLI works] For local verification: run `/verify` in Claude Code (auto-fixes failures), or `make verify-local` from terminal"
  - **What Changed**: list every file created and its purpose
  - **Why**: reference the experiment.yaml problem/solution
  - **Checklist — Scope**: check all boxes (only built what's in experiment.yaml)
  - **Checklist — Analytics**: list every event wired and which page fires it
  - **Checklist — Build**: confirm build passes, no hardcoded secrets, .env.example created
- Add a prominent note at the top of the PR body with post-merge instructions: database setup (from database stack file), environment variable setup (from .env.example)
- If Fake Door features exist: add a "## Fake Door Features" section listing each feature, its component file, and that it can be upgraded to a real integration via `/change`
- If provision-at-deploy routes exist: add a "## Provision at Deploy" section listing each service, its env vars, and that `/deploy` will prompt for credentials
- Fill in **every** section of the PR template. Empty sections are not acceptable. If a section does not apply, write "N/A" with a one-line reason.
- If `git push` or `gh pr create` fails: show the error and tell the user to check their GitHub authentication (`gh auth status`) and remote configuration (`git remote -v`), then retry the push and PR creation.
- Delete `.runs/current-plan.md` — the plan is now captured in the PR description.
- Tell the user: "Bootstrap PR created and ready to merge. Next: review the PR, merge to `main`, then run `/verify` to validate locally, and `/deploy` to set up cloud infrastructure and launch your app."

