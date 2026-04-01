# STATE 3: PROVISION

**PRECONDITIONS:**
- User approved deployment plan (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

> **Update mode behavior:** When `deploy_mode == "update"` (from deploy-context.json), provisioning is diff-based. The following steps are modified:
> - **Always execute** (both modes): Step 5a (code deploy), Step 4.4 (env var sync with upsert), and DB migrations (idempotent)
> - **Added services only**: Full provisioning (Steps 3, 3.5, 4.1–4.3 as applicable for new services)
> - **Unchanged services**: Skip provisioning entirely — health check in STATE 4 verifies they still work
> - **Removed services**: Skip entirely — marked orphaned in STATE 5 manifest
> - **Post-deploy agents (5b)**: Only spawn for added services
>
> For the steps below, "skip for update mode (unchanged)" means: skip this step if `deploy_mode == "update"` AND the relevant stack category is in `unchanged_services`.

### Step 3: Provision database

Skip this step if `stack.database` is absent or if the database stack file's `## Deploy Interface > Provisioning` says "none" (e.g., SQLite — auto-created on startup).

**Update mode:** If `deploy_mode == "update"` and database is in `unchanged_services`: skip provisioning but **always run migrations** — read the database stack file's migration command and execute it. Migrations are idempotent (already-applied migrations are no-ops). If database is in `added_services`: run full provisioning below.

**Initial mode / added service:** Read the database stack file's `## Deploy Interface > Provisioning` and follow each substep in order. The stack file specifies the exact CLI commands, polling logic, key extraction, and migration commands for the configured database provider.

### Step 3.5: Collect OAuth credentials (first deploy only)

Skip if `stack.auth_providers` is absent OR credentials already collected in Step 1.

Now that the Supabase ref is known from Step 3, for each provider in `auth_providers`:
show the callback URL (`https://<ref>.supabase.co/auth/v1/callback`), ask for Client ID
and Secret (or **skip**). Store as `oauth_credentials: { provider: { client_id, secret } }`.

### Step 4: Create hosting project and set env vars

#### 4.1: Project setup

**Update mode:** If `deploy_mode == "update"` and hosting is in `unchanged_services`: skip project setup (project already exists and is linked). Proceed to Step 4.4 (env var sync).

**Initial mode:** Read the hosting stack file's `## Deploy Interface > Project Setup`. Follow the instructions to create/link the project. For the GitHub integration step: connect GitHub for **PR preview deployments only** — then disable production auto-deploy per the hosting stack file's instructions. If the GitHub connection fails, set `git_connect_failed=true` (reported in Step 6 summary) — this is non-blocking since production deploys are manual.

#### 4.2: Domain setup

Read the hosting stack file's `## Deploy Interface > Domain Setup`. Follow the instructions to add a custom domain. The default parent domain is `draftlabs.org`; override with `deploy.domain` in experiment.yaml.
- **On success:** `canonical_url` = the custom domain, `domain_added` = true
- **On failure:** warn with the stack file's fallback message, set `canonical_url` = null (finalized after Step 5a deploy), `domain_added` = false

#### 4.3: Volume setup (if needed)

Read the database stack file's `## Deploy Interface > Hosting Requirements > volume_config`. If `needed: true`:
1. Read the hosting stack file's `## Deploy Interface > Volume Setup`
2. Follow the instructions to create a persistent volume with the specified mount path
3. Set the env vars from `volume_config.env_vars` using the hosting stack file's env var method

If the hosting stack file has no `Volume Setup` section, stop: "Hosting provider <provider> does not support persistent volumes, which are required by <database>."

#### 4.4: Set environment variables

> **Always executed in both initial and update mode.** Env vars are synced using upsert semantics — existing values are overwritten, new values are added. This ensures `.env.example` changes are reflected on the hosting provider.

Read the hosting stack file's `## Deploy Interface > Environment Variables` for the method (API, CLI, auth token location, fallback).

Collect all env vars and set them using the hosting provider's method:

   Variables from database provisioning (Step 3) — the database stack file's Provisioning substep specifies which env vars and their values.

   Additional variables (when `stack.auth: supabase` AND `stack.database` is NOT `supabase`):
   The auth stack needs a Supabase project even without the database stack. Ask the user for their existing Supabase project URL and anon key:
   - `NEXT_PUBLIC_SUPABASE_URL` — from Supabase Dashboard -> Settings -> API -> Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — from Supabase Dashboard -> Settings -> API -> Publishable Key

   Additional variables (when `stack.payment: stripe`):
   - `STRIPE_SECRET_KEY`
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
   - `STRIPE_WEBHOOK_SECRET` (skip if Stripe CLI is available — set after webhook creation in Step 5)

   Additional variables (when `stack.email` is present):
   - `RESEND_API_KEY` — ask the user (from resend.com -> API Keys)
   - `CRON_SECRET` — generate with `openssl rand -base64 24`

   Additional variables (external service credentials from bootstrap):
   - Read `.env.example` and collect all env var keys
   - Exclude keys already handled by stack categories above (database, Stripe, email, PostHog)
   - For each remaining key: read the value from `.env.local`. If found, set it on the hosting provider. If `.env.local` is missing or the key is absent, ask the user for the production value.

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
- **Agent C** (Analytics Dashboard): spawn if `stack.analytics: posthog`
- **Agent D** (External Services): spawn if any external stack files exist (Step 0.10 found services)

**Update mode filtering:** When `deploy_mode == "update"`, only spawn agents for services in `added_services`. Skip agents for `unchanged_services` (already configured from previous deploy) and `removed_services` (orphaned). For example, if `stack.analytics: posthog` is in `unchanged_services`, do NOT spawn Agent C.

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
**Receives:** `canonical_url`, database refs/keys (from Step 3, if supabase) OR user-provided Supabase URL/anon key (from Step 4.4, if database is not supabase), experiment.yaml `name`, database stack file path, `oauth_credentials` from Step 1/3.5, `stack.auth_providers`, `stack.email` value (from experiment.yaml), `RESEND_API_KEY` (from Step 4.4, when `stack.email: resend`)
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

#### Agent C — Analytics Dashboard

**Spawn condition:** `stack.analytics: posthog`
**Receives:** `canonical_url`, experiment.yaml `name`/`description`/`variants`, archetype type, `experiment/EVENTS.yaml` content, `stack.payment` presence
**Returns:** `{status: "ok"|"failed"|"skipped", message: "<details>", dashboard_url: "<url>"|null, env_vars_added: []}`

Instructions for Agent C:

Read the PostHog personal API key from `~/.posthog/personal-api-key` (same credential used by /iterate auto-query).

If the key does NOT exist:
1. Tell the user: "PostHog personal API key not found at `~/.posthog/personal-api-key`. To auto-create the experiment dashboard, create one now:"
   - Go to PostHog -> click your profile (bottom left) -> **Personal API keys**
   - Click **Create personal API key**
   - Label: `cli` (or anything)
   - Organization & project access: select your organization
   - Scopes: set **Dashboards** to **Write** and **Insights** to **Write** (all others can stay No access)
   - Click **Create key** and copy the key
2. Ask: "Paste the key here, or type **skip** to set up the dashboard manually later."
3. If key provided: save to `~/.posthog/personal-api-key` (`mkdir -p ~/.posthog && echo "$KEY" > ~/.posthog/personal-api-key`) and proceed with auto-creation below.
4. If skipped: return `{status: "skipped", message: "PostHog dashboard not auto-created — manual setup needed.", dashboard_url: null, env_vars_added: []}`.

If the key exists (or was just created), auto-create a dashboard via PostHog API:

First, discover the PostHog project ID:
```bash
POSTHOG_PROJECT_ID=$(curl -s "https://us.i.posthog.com/api/projects/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
```

```bash
# Create dashboard
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/dashboards/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "<project-name> Experiment", "description": "Auto-created by /deploy for <project-name>"}'
```

Extract the dashboard `id` from the response. Then create funnel insight. Build the funnel series from experiment/EVENTS.yaml `events` map: filter by `requires` (match experiment stack) and `archetypes` (match experiment type), order by funnel_stage (reach -> demand -> activate -> monetize -> retain). If the filtered events cover fewer than 2 funnel stages, log a warning ("Funnel insight skipped — filtered events cover fewer than 2 stages for this archetype/stack combination") and skip funnel creation (dashboard is still useful for individual event trends). For web-app this typically yields `visit_landing -> signup_start -> signup_complete -> activate` (plus `pay_start` and `pay_success` if `stack.payment` is present). For service/cli, this yields the events defined in the fixture (typically `activate -> retain_return`).

```bash
# Create funnel insight and add to dashboard
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/insights/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "<project-name> Funnel", "dashboards": [<dashboard_id>], "query": {"kind": "InsightVizNode", "source": {"kind": "FunnelsQuery", "series": [<archetype-appropriate EventsNode entries>], "filterTestAccounts": true, "properties": {"type": "AND", "values": [{"type": "AND", "values": [{"key": "project_name", "value": ["<project-name>"], "operator": "exact", "type": "event"}]}]}}}}'
```

If experiment.yaml has `variants` (web-app only): create a second funnel insight named `<project-name> Funnel by Variant` on the same dashboard, with the same series and filters as above, plus a breakdown:
```bash
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/insights/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "<project-name> Funnel by Variant", "dashboards": [<dashboard_id>], "query": {"kind": "InsightVizNode", "source": {"kind": "FunnelsQuery", "series": [<same web-app series>], "filterTestAccounts": true, "breakdownFilter": {"breakdown": "variant", "breakdown_type": "event"}, "properties": {"type": "AND", "values": [{"type": "AND", "values": [{"key": "project_name", "value": ["<project-name>"], "operator": "exact", "type": "event"}]}]}}}}'
```
Include `pay_start` and `pay_success` in the series if `stack.payment` is present. This lets the user compare conversion rates between variant landing pages — the core purpose of the variants feature.

If any API call fails, return `{status: "failed", message: "<error details>. To set up manually: go to PostHog → Dashboards → New dashboard → name it '<project-name> Experiment'. Add a funnel insight with the events from experiment/EVENTS.yaml filtered by project_name.", dashboard_url: null, env_vars_added: []}`.
If all API calls succeed, return `{status: "ok", message: "Dashboard and funnel insights created.", dashboard_url: "<PostHog dashboard URL>", env_vars_added: []}`.

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
2. Collect `dashboard_url` from Agent C result (for Step 6 summary).
3. Collect per-agent `status` and `message` (for Step 6 summary).
4. Collect `per_service` from Agent D result (for Step 6 external services section).

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
test -f .runs/deploy-provision.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh deploy 3
```

**NEXT:** Read [state-4-health-check.md](state-4-health-check.md) to continue.
