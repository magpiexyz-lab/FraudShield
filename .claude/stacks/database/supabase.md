---
assumes: [framework/nextjs]
packages:
  runtime: ["@supabase/supabase-js", "@supabase/ssr", pg]
  dev: []
files:
  - src/lib/supabase.ts
  - src/lib/supabase-server.ts
  - src/lib/types.ts
  - scripts/auto-migrate.mjs
env:
  server: []
  client: [NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY]
ci_placeholders:
  NEXT_PUBLIC_SUPABASE_URL: "https://placeholder.supabase.co"
  NEXT_PUBLIC_SUPABASE_ANON_KEY: placeholder-anon-key
clean:
  files: []
  dirs: []
gitignore: []
---
# Database: Supabase (Postgres)
> Used when experiment.yaml has `stack.database: supabase`
> Assumes: `framework/nextjs` (server client uses `next/headers` for cookies)

## Packages
```bash
npm install @supabase/supabase-js @supabase/ssr pg
```

## Files to Create

### `src/lib/supabase.ts` — Browser client
```ts
import { createBrowserClient } from "@supabase/ssr";

function createDemoClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chainable = (terminal: unknown): any =>
    new Proxy(() => terminal, {
      get: (_, prop) => (prop === "then" ? undefined : chainable(terminal)),
      apply: () => chainable(terminal),
    });
  const query = () => chainable({ data: [], error: null });
  return {
    from: () => ({
      select: query,
      insert: query,
      update: query,
      delete: query,
      upsert: query,
    }),
    auth: new Proxy(
      {
        getUser: () =>
          Promise.resolve({
            data: {
              user: {
                id: "demo-user-id",
                email: "demo@example.com",
                app_metadata: {},
                user_metadata: {},
                aud: "authenticated",
                created_at: new Date().toISOString(),
              },
            },
            error: null,
          }),
        getSession: () =>
          Promise.resolve({ data: { session: null }, error: null }),
        onAuthStateChange: () => ({
          data: { subscription: { unsubscribe: () => {} } },
        }),
      },
      {
        get: (target, prop) =>
          prop in target
            ? target[prop as keyof typeof target]
            : () => Promise.resolve({ data: {}, error: null }),
      }
    ),
    rpc: () => chainable({ data: null, error: null }),
  } as unknown as ReturnType<typeof createBrowserClient>;
}

export function createClient() {
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") return createDemoClient();
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key"
  );
}
```

### `src/lib/supabase-server.ts` — Server client for API routes
```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function createDemoClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chainable = (terminal: unknown): any =>
    new Proxy(() => terminal, {
      get: (_, prop) => (prop === "then" ? undefined : chainable(terminal)),
      apply: () => chainable(terminal),
    });
  const query = () => chainable({ data: [], error: null });
  return {
    from: () => ({
      select: query,
      insert: query,
      update: query,
      delete: query,
      upsert: query,
    }),
    auth: new Proxy(
      {
        getUser: () =>
          Promise.resolve({
            data: {
              user: {
                id: "demo-user-id",
                email: "demo@example.com",
                app_metadata: {},
                user_metadata: {},
                aud: "authenticated",
                created_at: new Date().toISOString(),
              },
            },
            error: null,
          }),
        getSession: () =>
          Promise.resolve({ data: { session: null }, error: null }),
      },
      {
        get: (target, prop) =>
          prop in target
            ? target[prop as keyof typeof target]
            : () => Promise.resolve({ data: {}, error: null }),
      }
    ),
    rpc: () => chainable({ data: null, error: null }),
  } as unknown as ReturnType<typeof createServerClient>;
}

export async function createServerSupabaseClient() {
  if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV === "production") {
    throw new Error("DEMO_MODE is not allowed in production");
  }
  if (process.env.DEMO_MODE === "true") return createDemoClient();
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://placeholder.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "placeholder-anon-key",
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        },
      },
    }
  );
}
```
- Use this in all API route handlers (`src/app/api/`) and Server Components
- Import `cookies` from `next/headers` (server-only)
- The cookie-based approach preserves the user's auth session server-side

### `scripts/auto-migrate.mjs`

Runs as the `prebuild` script before every `npm run build`. Applies SQL migrations from `supabase/migrations/` in order, tracking applied migrations in an `_auto_migrations` table.

```js
import { loadEnvConfig } from "@next/env";
import pg from "pg";
import { readdir, readFile } from "fs/promises";
import { join } from "path";

loadEnvConfig(process.cwd());

const connectionString = process.env.POSTGRES_URL_NON_POOLING;
if (!connectionString) process.exit(0); // No database URL — skip silently (local dev, CI)

const client = new pg.Client({ connectionString });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS _auto_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ DEFAULT now()
  )
`);

const { rows: applied } = await client.query("SELECT name FROM _auto_migrations");
const appliedSet = new Set(applied.map((r) => r.name));

const migrationsDir = join(process.cwd(), "supabase", "migrations");
let files;
try {
  files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
} catch {
  await client.end();
  process.exit(0); // No migrations directory — skip
}

for (const file of files) {
  if (appliedSet.has(file)) continue;
  const sql = await readFile(join(migrationsDir, file), "utf8");
  await client.query(sql);
  await client.query("INSERT INTO _auto_migrations (name) VALUES ($1)", [file]);
  console.log(`Applied migration: ${file}`);
}

await client.end();
```

## Environment Variables
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-publishable-api-key
```

> **Note:** `NEXT_PUBLIC_SUPABASE_ANON_KEY` keeps its name for SDK compatibility, but in the Supabase Dashboard this is called **Publishable Key** (Project Home → Data API popup). New keys start with `sb_publishable_`.

## Schema Management
- SQL migrations go in `supabase/migrations/` as numbered files (`001_initial.sql`, `002_feature.sql`, etc.)
- Use `CREATE TABLE IF NOT EXISTS` for tables and `DROP POLICY IF EXISTS ... ; CREATE POLICY ...` for RLS policies (safe to re-run — `CREATE POLICY IF NOT EXISTS` is not valid PostgreSQL)
- Every table must have:
  - `id uuid DEFAULT gen_random_uuid() PRIMARY KEY`
  - `created_at timestamptz DEFAULT now()`
- User-owned tables must have:
  - `user_id uuid REFERENCES auth.users(id) NOT NULL`
- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on every table
- RLS policies: `auth.uid() = user_id`
- Add SQL comments explaining each table's purpose
- Migrations are applied automatically during Vercel builds via the `prebuild` script (when `POSTGRES_URL_NON_POOLING` is set by the Supabase Vercel Integration). They are also applied by CI on merge to `main` (via `supabase db push` if CI secrets are configured). For manual use: `make migrate`. Fallback: copy SQL into Supabase Dashboard → SQL Editor.

## Local Development (when `stack.testing` is present)

When the project has `stack.testing` configured, E2E tests run against a **local** Supabase instance instead of the remote project. This keeps tests isolated, fast, and secret-free.

- `supabase init` creates `supabase/config.toml` (commit this file — it configures the local instance)
- `supabase start` starts local Postgres + Auth + API (requires Docker Desktop)
- `supabase db reset` applies all migrations from `supabase/migrations/`
- `supabase stop` shuts down the local instance

## Remote Migration (Production)

Migrations are pushed to the remote Supabase database using `supabase db push`. This happens automatically in CI on merge to `main`, or manually via `make migrate`.

### One-time setup (local `make migrate`)
1. Run `npx supabase login` to authenticate the CLI
2. Run `npx supabase link --project-ref <ref>` to link to your remote project
   - Find your project ref: Supabase Dashboard → Settings → General → Reference ID
3. Set `SUPABASE_DB_PASSWORD` in your shell: `export SUPABASE_DB_PASSWORD=your-password`
   - Find it: Supabase Dashboard → Settings → Database → Database password
4. Run `make migrate`

### One-time setup (CI auto-migration)
Add three GitHub repository secrets (repo → Settings → Secrets and variables → Actions):
| Secret | Where to find it |
|--------|-----------------|
| `SUPABASE_PROJECT_REF` | Supabase Dashboard → Settings → General → Reference ID |
| `SUPABASE_DB_PASSWORD` | Supabase Dashboard → Settings → Database → Database password |
| `SUPABASE_ACCESS_TOKEN` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) → Generate new token |

## CLI Project Creation (Non-Interactive)

Used by the `/deploy` skill for automated Supabase setup.

### Organization Discovery
- `supabase orgs list -o json` — returns `[{"id": "...", "name": "..."}]`

### Project Creation
- `supabase projects create <name> --org-id <id> --region <region> --db-password <pw>`
- Password: generate with `openssl rand -base64 24`
- Project takes ~60s to initialize after creation

### Readiness Polling
- `supabase projects api-keys --project-ref <ref> -o json`
- Poll every 5s, max 12 attempts (60s total)
- Returns: `[{"name": "anon", "api_key": "..."}, {"name": "service_role", "api_key": "..."}]`

### URL/Connection String Construction
- URL: `https://<ref>.supabase.co`
- DB (non-pooling): Discover the pooler host via the Management API:
  ```bash
  curl -s "https://api.supabase.com/v1/projects/<ref>/config/database/pooler" \
    -H "Authorization: Bearer <access-token>"
  ```
  Use the `host` from the response with port `5432` (session mode = direct connection):
  `postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres`

## Auto-Migration on Vercel Build

When deployed via the Supabase Vercel Integration, migrations are applied automatically during every Vercel build via a `prebuild` script (`scripts/auto-migrate.mjs`). No additional configuration needed.

### How it works
- `package.json` has `"prebuild": "node scripts/auto-migrate.mjs"`
- npm runs `prebuild` before every `build` (including on Vercel)
- The script connects using `POSTGRES_URL_NON_POOLING` (injected by the Integration)
- Applies all SQL files from `supabase/migrations/` in order
- Tracks applied migrations in `_auto_migrations` table to avoid re-running
- If `POSTGRES_URL_NON_POOLING` is not set (local dev, CI), exits silently

### Coexistence with CI migrate and supabase db push
- Auto-migrate tracks in `_auto_migrations`; `supabase db push` tracks in `supabase_migrations.schema_migrations`
- Independent tracking, no conflict — migrations are idempotent (`IF NOT EXISTS`)
- Both can be active safely; CI migrate provides a fallback for non-Vercel deployments

### Local keys

These keys are generated by the local Supabase instance. On CLI versions before v2.76, they are deterministic JWT tokens. On v2.76+, they use the `sb_publishable_*`/`sb_secret_*` format and may vary across installs. The testing stack reads keys dynamically from `supabase status -o json` — hardcoding is no longer necessary.

- **URL:** `http://127.0.0.1:54321`
- **Legacy anon key (CLI <v2.76):** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0`
- **Legacy service role key (CLI <v2.76):** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU`

## Types
- Create TypeScript types matching table schemas in `src/lib/types.ts`

## Security
- Never expose `service_role` key to the client
- Always use RLS — never trust the client
- Use the server client (`supabase-server.ts`) in all API route handlers

## Patterns
- Browser client (`supabase.ts`) for client-side components
- Server client (`supabase-server.ts`) for API routes — always verify session server-side
- When creating a new migration, use the next sequential number after existing migrations. Note: concurrent branches may create conflicting numbers (e.g., two branches both create `002_*.sql`) — resolve by renumbering the later-merged migration at merge time. This is acceptable for MVP workflows.

## PR Instructions
- When creating migrations, add to the PR body: "After merging, migrations are applied automatically during the next Vercel build (via the `prebuild` script). If not using the Supabase Vercel Integration, CI applies them on merge to `main` (requires CI secrets), or run `make migrate` manually — see Migration Setup in README."
- For the bootstrap PR, also add: "Run `/deploy` to set up Vercel + Supabase automatically, or manually add the Supabase Vercel Integration at vercel.com/integrations/supabase."

## Deploy Interface

Standardized subsections referenced by deploy.md and teardown.md. Each subsection is a self-contained recipe — deploy.md reads them by name and executes the instructions.

### Prerequisites

- **install_check:** `which supabase`
- **install_fix:** `brew install supabase/tap/supabase` (macOS/Linux) or see https://supabase.com/docs/guides/cli/getting-started
- **auth_check:** `supabase projects list`
- **auth_fix:** `supabase login`

### Config Gathering

- **Org discovery:** `supabase orgs list -o json` — returns `[{"id": "...", "name": "..."}]`
- Always prompt user for org/region selection or use Supabase CLI defaults (no experiment.yaml fields for these)

### Provisioning

1. **Check existing:** `supabase projects list -o json` — if a project with this name exists in the org, ask the user whether to reuse or create new
2. **Create project:**
   ```bash
   supabase projects create <name> --org-id <org-id> --region <region> --db-password <password>
   ```
   Password: generate with `openssl rand -base64 24`
3. **Extract ref** from creation output
4. **Readiness polling:**
   ```bash
   supabase projects api-keys --project-ref <ref> -o json
   ```
   Poll every 5s, max 12 attempts (60s total). Returns:
   `[{"name": "anon", "api_key": "..."}, {"name": "service_role", "api_key": "..."}]`
5. **Extract keys:**
   - `anon` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`
6. **Construct URLs:**
   - `NEXT_PUBLIC_SUPABASE_URL` = `https://<ref>.supabase.co`
   - `POSTGRES_URL_NON_POOLING`: query the pooler config (**after** project is ACTIVE_HEALTHY):
     ```bash
     curl -s "https://api.supabase.com/v1/projects/<ref>/config/database/pooler" \
       -H "Authorization: Bearer <token>"
     ```
     If empty (`[]`), wait 5s and retry (max 3 attempts). Use `host` with port `5432`:
     `postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres`
7. **Link local project:**
   ```bash
   supabase link --project-ref <ref>
   ```
8. **Apply migrations** (if `supabase/migrations/` has files):
   ```bash
   supabase db push --yes
   ```

### Hosting Requirements

- **incompatible_hosting:** `[]`
- **volume_config:** `{ needed: false }`

### Auth Config

**Spawn condition:** `stack.auth: supabase` AND `stack.database: supabase`

1. **Read Supabase access token** (try in order):
   - File: `~/.supabase/access-token`
   - macOS Keychain: `security find-generic-password -s "Supabase CLI" -w 2>/dev/null` — strip `go-keyring-base64:` prefix, base64-decode remainder
   - If neither found: ask user for token (generate at supabase.com/dashboard/account/tokens) or skip
2. **Extract short title:** experiment.yaml `title` up to first ` — `, ` - `, or ` | ` delimiter; fallback to capitalized `name`
3. **Configure auth:**
   ```bash
   curl -s -X PATCH "https://api.supabase.com/v1/projects/<ref>/config/auth" \
     -H "Authorization: Bearer <token>" \
     -H "Content-Type: application/json" \
     -d '{"site_url": "https://<canonical_url>", "uri_allow_list": "https://<canonical_url>/**", "mailer_subjects_confirmation": "Confirm your <short-title> account", "mailer_subjects_recovery": "Reset your <short-title> password", "mailer_subjects_magic_link": "Your <short-title> login link"}'
   ```

4. **Configure OAuth providers** (if `stack.auth_providers` present and credentials provided):
   Include in the same PATCH call: `"external_<provider>_enabled": true,
   "external_<provider>_client_id": "<id>", "external_<provider>_secret": "<secret>"`.
   Supported slugs: google, github, apple, azure, bitbucket, discord, facebook,
   figma, gitlab, kakao, keycloak, linkedin_oidc, notion, slack_oidc, spotify,
   twitch, twitter, workos, zoom.

### Teardown

1. **Pre-delete safety check** — query user-facing table row counts:
   ```bash
   curl -s "https://<ref>.supabase.co/rest/v1/<table>?select=count" \
     -H "Authorization: Bearer <service_role_key>" \
     -H "apikey: <anon_key>" \
     -H "Prefer: count=exact"
   ```
   Check tables from `supabase/migrations/` (parse CREATE TABLE statements). If any table has rows > 0, warn and require explicit `delete` confirmation.
2. **Delete project:**
   ```bash
   supabase projects delete --project-ref <ref>
   ```
3. **Dashboard URL (manual fallback):** `https://supabase.com/dashboard/project/<ref>/settings/general`

### Manifest Keys

```json
{
  "provider": "supabase",
  "ref": "<ref>",
  "org_id": "<org-id>"
}
```
