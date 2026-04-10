# STATE 3b: PROVISION_HOST

**PRECONDITIONS:**
- STATE 3a POSTCONDITIONS met (database credentials available for env var setting)

**ACTIONS:**

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
   - `RESEND_FROM` — set to `noreply@<domain>` where `<domain>` is `deploy.domain` from experiment.yaml; fallback to `draftlabs.org`

   Additional variables (external service credentials from bootstrap):
   - Read `.env.example` and collect all env var keys
   - Exclude keys already handled by stack categories above (database, Stripe, email, PostHog)
   - For each remaining key: read the value from `.env.local`. If found, set it on the hosting provider. If `.env.local` is missing or the key is absent, ask the user for the production value.

- **Write intermediate artifact** (`.runs/deploy-provision-3b.json`):
  ```bash
  python3 -c "
  import json
  artifact = {
      'hosting_created': True,   # or False if skipped for update mode
      'domain_added': True,      # or False if failed
      'canonical_url': '<url or null>',
      'git_connect_failed': False,
      'env_vars_set': True
  }
  json.dump(artifact, open('.runs/deploy-provision-3b.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Hosting project created/linked
- Domain configured (or fallback recorded)
- All environment variables set on hosting provider
- `.runs/deploy-provision-3b.json` exists

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/deploy-provision-3b.json')); assert d.get('hosting_created') is True, 'hosting_created not True'; assert d.get('env_vars_set') is True, 'env_vars_set not True'; assert d.get('canonical_url','')!='', 'canonical_url empty'; assert d.get('domain_added') is True, 'domain_added not True'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh deploy 3b
```

**NEXT:** Read [state-3c-deploy-services.md](state-3c-deploy-services.md) to continue.
