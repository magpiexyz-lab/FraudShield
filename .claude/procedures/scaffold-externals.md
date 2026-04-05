# Scaffold: External Dependencies

## Prerequisites
- Packages installed (Step 1 finished)
- Stack files and `.claude/stacks/TEMPLATE.md` on disk
- `.runs/current-plan.md` exists

## Instructions

### Evaluate external dependencies

Before API routes are generated, assess whether experiment.yaml features require external services not covered by `stack`:

1. Read experiment.yaml `behaviors`. For each behavior, assess: does it require credentials for an external service (OAuth, API key, webhook secret) that is NOT already handled by a `stack` category (database, auth, payment, email, analytics)?
   - Examples: "Connect Xero and import invoices" → Xero OAuth, "Send SMS via Twilio" → Twilio API key, "Sync with Google Sheets" → Google OAuth
   - Stack-handled services don't count: Supabase, Stripe, Resend, PostHog are already managed by their stack files

2. If NO external dependencies detected → report "No external dependencies" and finish.

3. **Classify each dependency as core or non-core.** For each external dependency, ask: "If this feature were entirely absent, could users still validate the `thesis`?" If no → **core**. If yes → **non-core**. Present the classification to the user for confirmation or override:

   > These features require external service credentials not covered by your stack:
   >
   > | Feature | Service | Credentials needed | Classification |
   > |---------|---------|-------------------|----------------|
   > | ... | ... | ... | **core** / **non-core** |
   >
   > Core = removing it prevents users from validating the thesis.
   >
   > Does this classification look right? If so, choose an option for each:

4. **Core features — two options** (no Skip, no Fake Door — core features must have a complete experience):
   - **Provide now** — user gives credentials during bootstrap, Step 5 builds full integration
   - **Provision at deploy** — Step 5 builds full integration code referencing env vars; credentials are obtained during `/deploy` Step 5b. Code must compile without real credentials (guard with runtime check → 503 `{ error: "Service not configured" }` + `console.error(\`[503] [name] not configured — run /deploy to provision\`)`).

5. **Non-core features — three options:**
   - **Fake Door** (default) — real UI + `activate` event with `fake_door: true` + "Coming soon" dialog. Collects intent data from paid traffic. See Fake Door output format below.
   - **Skip** — omit the feature from the UI entirely (not a 501 stub — the feature is simply not built)
   - **Full Integration** — same as core "Provide now" (user gives credentials, Step 5 builds it)

**Steps 6-8 below are executed by the bootstrap lead** after reviewing your
classification. Include them here for reference so the lead knows what to do.

6. **Auto-generate external stack files.** For each fully-integrated service (core or non-core with "Full Integration", "Provide now", or "Provision at deploy"), check if `.claude/stacks/external/<service-slug>.md` exists. If not, generate it:
   - **Check Known Service Quirks** (below) for the service name. If an entry exists, incorporate its documented patterns into the generated stack file (e.g., correct auth flow, known gotchas, required headers).
   - Read `.claude/stacks/TEMPLATE.md` for the required frontmatter schema
   - Read existing stack files as structural reference
   - Generate `.claude/stacks/external/<service-slug>.md` with: OAuth/API flow documentation, required env vars, code templates for client library and route handlers, rate limits and quotas, sandbox/test mode details, and a `## CLI Provisioning` section
   - **Env var naming:** If the framework is Next.js, client-accessible env vars must use the `NEXT_PUBLIC_` prefix (Next.js inlines them at build time). Declare server-only vars in `env.server` and client-accessible vars in `env.client`. Example: an OAuth client ID used in browser-side redirect URLs needs `NEXT_PUBLIC_<SERVICE>_CLIENT_ID` in `env.client`, while the secret stays in `env.server`.
   - Set `ci_placeholders: {}` — external service env vars are runtime-only
     (guarded by 503 when missing) and must not appear in CI
   - Run `python3 scripts/validate-frontmatter.py` to verify (max 2 attempts)
   - After generating the external stack file, search the web for the service's
     current official API/OAuth documentation to verify:
     - OAuth scope names and format
     - Authorization and token endpoint URLs
     - Required request parameters and headers
     If any generated value conflicts with the official documentation, update the
     stack file before proceeding.
   - Tell the user: "Generated `.claude/stacks/external/<service-slug>.md` — auto-generated from Claude's knowledge. Review after bootstrap."
   - File an observation per `.claude/patterns/observe.md`

   The generated external stack file must include a `## CLI Provisioning` section. If the service has a CLI that can create credentials:
   ```
   ## CLI Provisioning
   cli: <command-name>
   install: <install-command>
   auth: <auth-check-command>
   provision: <provisioning-command-template>
   ```
   If the service has no CLI, write: "No CLI available — credentials must be obtained via the web dashboard."
   This section is read by `/deploy` to check CLI availability and attempt auto-provisioning.

7. For each service where the user chooses "Provide now" or "Full Integration":
   - Provide brief setup instructions for obtaining the credentials:
     - Where to sign up or access the developer console (include URL)
     - How to create the app/key (3-5 concrete steps)
     - Which credential values to copy (Client ID, API Key, Secret, etc.)
     - Note if a free tier or sandbox is available for MVP testing
   - Then ask the user for the credential values
   - Add env vars to `.env.local` (real values) and `.env.example` (placeholder values only — never real credentials)
   - Step 5 implements the full integration using the credentials (OAuth flow, API calls, etc.)

8. For "Provision at deploy" services:
   - Add env vars to `.env.example` with placeholder values and a comment: `# Provisioned by /deploy`
   - Step 5 builds full integration code referencing these env vars (see Step 5 provision-at-deploy routes below)

### Fake Door output format

For each non-core feature choosing Fake Door, include in your output a structured entry:
```
- feature: [feature name]
  service: [external service]
  target_page: [page where the feature would naturally appear]
  component_name: [kebab-case component file name, e.g., sms-fake-door.tsx]
  action_label: [feature-name for the activate event action]
```

Do NOT create the Fake Door components — they are created by the orchestrator
after all parallel agents complete (they live in `src/app/<page>/`, which is
the pages subagent's territory).

## Known Service Quirks

Cross-project patterns observed when integrating external services. Check this
section before auto-generating an external stack file (Step 6). When closing
observations about external service pitfalls, extract the root-cause finding
here before closing.

Entry format:
```
### <Service Name>
- **Quirk**: <one-line description>
- **Detail**: <what goes wrong and why>
- **Mitigation**: <what the generated stack file should include>
- **Source**: #<issue-number> or <project-name>
```

### Twilio
- **Quirk**: TwiML XML injection via unsanitized interpolation
- **Detail**: TwiML responses that interpolate user-supplied or database-stored strings (practice names, phone numbers, service lists) are vulnerable to XML injection. Characters like `<`, `>`, `&`, `"` break the TwiML structure or inject arbitrary TwiML verbs.
- **Mitigation**: The generated stack file must include an `escapeXml()` helper that escapes all 5 XML special characters, and all TwiML code templates must use it for every interpolated value. Also validate all FormData fields with zod before building the TwiML response.
- **Source**: #598

### Retell AI
- **Quirk**: Webhook agent_id cross-validation and PII in logs
- **Detail**: Retell AI webhook routes that process call results should cross-validate the `agent_id` in the payload against the practice/user record in the database. A valid Retell signature alone does not prevent a legitimate agent from posting to the wrong endpoint. Additionally, phone numbers in log output constitute PII exposure.
- **Mitigation**: The generated stack file must include: (1) after signature verification, validate `agent_id` against the stored record, (2) redact phone numbers and PII from all log output, (3) remove internal service names from error responses.
- **Source**: #599

