# STATE 3c: DEPLOY_SERVICES

**PRECONDITIONS:**
- STATE 3b POSTCONDITIONS met (hosting project exists with env vars set, canonical_url partially determined)

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table + Compound Dimensions "Deploy gate".
>
> Deploy gate — web-app/co-located: full deploy | service/none: stop | cli/detached: surface-only | cli/none: stop

### Step 5a: Initial deploy

If surface is `detached` and the archetype's `excluded_stacks` includes `hosting` (e.g., CLI), OR if the archetype is `service` and surface is `detached`: **skip this step** — proceed directly to Step 5a.1 (surface-only deployment). Archetypes with detached surfaces have no hosting infrastructure to deploy to.

1. Read the hosting stack file's `## Deploy Interface > Deploy`. Execute the deploy command.
2. Extract the deployment URL per the stack file's instructions.
3. If `canonical_url` is null (domain add failed or no `deploy.domain`): set `canonical_url` = the deployment URL.

### Step 5a.1: Surface deployment (if surface is `detached`)

1. Verify `site/index.html` exists. If not, stop: "Surface page not found. Run `/bootstrap` to generate it."
2. Read the surface stack file at `.claude/stacks/surface/detached.md` -> `## Deployment`. Deploy the surface using the command specified there (e.g., `vercel site/ --prod`).
3. Extract the deployment URL from the command output.
4. If `deploy.domain` is set in experiment.yaml: bind custom domain (`<name>.<domain>`) to the deployed surface.
5. Set `surface_url` = custom domain URL or deployment URL.
6. For archetypes with detached surface (CLI, service): `canonical_url` = `surface_url` (the surface IS the canonical web presence).

### Step 5b: Post-deploy service configuration (parallel)

Configure services using `canonical_url` (custom domain if added in Step 4.2, otherwise deployment URL). Up to 4 independent agents run **simultaneously** — each calls a different external API with no shared mutable state.

#### 5b preamble: determine which agents to spawn

> **Surface-only gate:** If the archetype's `excluded_stacks` includes `hosting` and surface is `detached` (surface-only deployment): skip Step 5b entirely — no hosting infrastructure was provisioned. Proceed to Step 5c (health check verifies the surface URL).

Assemble the shared context block (read-only inputs for all agents):
- `canonical_url`, experiment.yaml contents (name, description, variants, stack, type), `experiment/EVENTS.yaml` contents, archetype type
- If Steps 3–4 were executed (not skipped for CLI detached): hosting env var method (from hosting stack file's `## Deploy Interface > Environment Variables`), database refs/keys (from Step 3), hosting project `name` and team/account (from Step 4), hosting and database stack file paths
- CLI statuses from Step 0 (if Step 0.10 was executed)

Determine which agents to launch based on experiment.yaml stack (all use
`subagent_type: general-purpose`):
- **Agent A** (Supabase Auth): spawn if `stack.auth: supabase` (regardless of database provider — Step 4.4 collects Supabase credentials when database is not supabase)
- **Agent B** (Stripe Webhook): spawn if `stack.payment: stripe` AND Stripe CLI is available
- **Agent D** (External Services): spawn if any external stack files exist (Step 0.10 found services)

**Update mode filtering:** When `deploy_mode == "update"`, only spawn agents for services in `added_services`. Skip agents for `unchanged_services` (already configured from previous deploy) and `removed_services` (orphaned).

Launch all applicable agents **simultaneously** using parallel Agent tool calls. Each agent returns a result object: `{status, message, env_vars_added, ...}`.

**Timeout policy:** Each agent has a 5-minute timeout. If an agent doesn't complete within 5 minutes:
- Log: "Agent [name] timed out after 5 minutes"
- Record: `{status: "timeout", message: "Agent timed out"}`
- Continue with other agents — do not block

**Partial failure policy:** After all agents complete (or timeout):
- If ALL succeeded: proceed normally
- If ANY failed/timed out: list failures in Step 6 summary. Each agent's `message` field must contain actionable manual setup instructions (dashboard URLs, CLI commands, or stack file references) so the user can complete configuration without re-running `/deploy`.
- Do NOT retry automatically — the user can re-run `/deploy` to retry failed agents

---

#### Agent A — Database Auth config

**Spawn condition:** `stack.auth: supabase`
**Receives:** `canonical_url`, database refs/keys (from Step 3, if supabase) OR user-provided Supabase URL/anon key (from Step 4.4, if database is not supabase), experiment.yaml `name`, database stack file path, `oauth_credentials` from Step 1/3.5, `stack.auth_providers`, `stack.email` value (from experiment.yaml), `RESEND_API_KEY` (from Step 4.4, when `stack.email: resend`), `deploy.domain` (from experiment.yaml, for SMTP sender address)
**Returns:** `{status: "ok"|"failed"|"skipped", message: "<details>", env_vars_added: [], oauth_configured: ["google", ...], oauth_skipped: ["github", ...], smtp_configured: true|false, templates_configured: true|false}`

Instructions for Agent A:

Read the database stack file's `## Deploy Interface > Auth Config`. If the section is absent (database provider has no auth config), return `{status: "skipped", message: "Database provider has no auth config section.", env_vars_added: []}`.

If `stack.database` does not match `stack.auth`'s expected database (e.g., auth is supabase but no supabase project was created in Step 3): use the user-provided Supabase URL and anon key from Step 4.4 to derive the project ref (extract from URL: `https://<ref>.supabase.co`). Discover the access token and proceed with auth config using the same API calls as the matching-database path. If the user-provided credentials are missing or invalid, return `{status: "failed", message: "Supabase auth config failed — provide valid Supabase URL/anon key or configure auth manually in the Supabase dashboard.", env_vars_added: []}`.

Follow the Auth Config section's instructions step by step — it specifies how to discover the access token, what API call to make, and what fields to set using `canonical_url`.

**OAuth provider configuration** (if `stack.auth_providers` present AND credentials collected):
Include in the same PATCH call to `/v1/projects/{ref}/config/auth`:
```json
"external_<provider>_enabled": true,
"external_<provider>_client_id": "<id>",
"external_<provider>_secret": "<secret>"
```
For skipped providers (user typed **skip**), do not include them in the PATCH call.
Record configured providers in `oauth_configured` and skipped providers in `oauth_skipped`.

---

#### Agent B — Stripe Webhook

**Spawn condition:** `stack.payment: stripe` AND Stripe CLI is available
**Receives:** `canonical_url`, hosting env var method (from hosting stack file), hosting project `name`/team, hosting stack file path
**Returns:** `{status: "ok"|"failed"|"skipped", message: "<details>", env_vars_added: ["STRIPE_WEBHOOK_SECRET"]|[]}`

Instructions for Agent B:

Check for existing endpoint: `stripe webhook_endpoints list` — if an endpoint with URL `https://<canonical_url>/api/webhooks/stripe` already exists, return `{status: "ok", message: "Stripe webhook already exists.", env_vars_added: []}`.
Otherwise:
```bash
stripe webhook_endpoints create \
  --url "https://<canonical_url>/api/webhooks/stripe" \
  --events checkout.session.completed
```
Extract the webhook signing secret (`whsec_...`) from the output. Set it using the hosting stack file's `## Deploy Interface > Environment Variables` method (primary method with fallback).

Return `{status: "ok", message: "Stripe webhook created and secret set.", env_vars_added: ["STRIPE_WEBHOOK_SECRET"]}`.
If webhook creation fails, return `{status: "failed", message: "<error details>. To configure manually: go to Stripe Dashboard → Developers → Webhooks → Add endpoint. URL: https://<canonical_url>/api/webhooks/stripe, events: checkout.session.completed. Copy the signing secret and set STRIPE_WEBHOOK_SECRET via the hosting provider's env var method.", env_vars_added: []}`.

---

#### Agent D — External Services

**Spawn condition:** any external stack files exist (Step 0.10 found services)
**Receives:** `canonical_url`, hosting env var method (from hosting stack file), hosting project `name`/team, hosting stack file path, external CLI statuses from Step 0.10, external stack file paths
**Returns:** `{status: "ok"|"partial"|"failed"|"skipped", message: "<details>", env_vars_added: ["KEY1", ...], per_service: [{name, status, message}]}`

Instructions for Agent D:

For each external service (using CLI status from Step 0.10):

**Auto via CLI** (ready): Read `## CLI Provisioning` from external stack file -> execute provision command with canonical URL -> extract credentials -> set env vars using the hosting stack file's `## Deploy Interface > Environment Variables` method. If provisioning fails: tell user "[service] CLI provisioning failed: [error]. Falling back to manual setup." Then proceed to Manual setup.

**Manual (CLI available)** (not_installed/not_authed): Tell user: "[service] has CLI `<cli>` for auto-provisioning. Install: `<install-cmd>`. Or provide credentials manually now." Then proceed to Manual setup.

**Manual setup** (shared path for "CLI available", "no CLI", and auto-provision failures): Read external stack file for instructions. Provide step-by-step guidance:
- Where to create credentials (include URL)
- Canonical URL for redirect URIs (e.g., `https://<canonical_url>/api/auth/callback/<service>`)
- Which values to copy
- Ask for credentials, or offer **skip** — feature returns 503 until configured via the hosting provider's env var CLI
- Set env vars using the hosting stack file's env var method

Collect all env vars added across all services. Return `{status, message, env_vars_added: [...all keys set...], per_service: [{name, status, message}, ...]}`.

---

#### 5b post-join: collect results

**Wait for all agents to complete before continuing.**

1. Collect `env_vars_added` arrays from all agent results into a single list.
2. Collect per-agent `status` and `message` (for Step 6 summary).
3. Collect `per_service` from Agent D result (for Step 6 external services section).

#### 5b.5: Redeploy (only if any agent reported non-empty `env_vars_added`)

Read the hosting stack file's `## Deploy Interface > Deploy` and execute the deploy command.

Note: projects with Stripe require two production deploys during first-time setup (one to get the URL, one after webhook secret is configured). Subsequent deploys via git push need only one.

- **Write provision artifact** (`.runs/deploy-provision.json`):
  ```bash
  python3 -c "
  import json
  provision = {
      'database_provisioned': True,   # or False if skipped
      'hosting_created': True,
      'domain_configured': True,      # or False if failed
      'canonical_url': '<deployment url>',
      'agents_completed': []          # list of {agent, status}
  }
  json.dump(provision, open('.runs/deploy-provision.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Database provisioned (if applicable) with migrations applied
- Hosting project created with all env vars set
- Domain configured (or fallback recorded)
- Initial deploy complete with deployment URL extracted
- Post-deploy agents completed (auth, stripe, analytics, external services)
- Redeploy triggered if any agents added env vars
- `.runs/deploy-provision.json` exists

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/deploy-provision.json')); assert d.get('hosting_created') is True, 'hosting_created not True'; assert d.get('canonical_url','')!='', 'canonical_url empty'; assert isinstance(d.get('agents_completed'), list) and len(d['agents_completed'])>0, 'agents_completed empty or missing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh deploy 3c
```

**NEXT:** Read [state-4a-health-fix.md](state-4a-health-fix.md) to continue.
