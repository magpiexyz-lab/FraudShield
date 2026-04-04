---
# YAML Frontmatter Schema — every stack file must include this block.
# The validate-frontmatter.py script checks these keys on every PR.
#
# assumes:          list[str]  — other stack files this depends on (e.g., [framework/nextjs])
# packages:
#   runtime:        list[str]  — npm packages installed with `npm install`
#   dev:            list[str]  — npm packages installed with `npm install -D`
# files:            list[str]  — source files this stack creates (relative to repo root)
# env:
#   server:         list[str]  — server-only environment variable names
#   client:         list[str]  — client-side environment variable names (e.g., NEXT_PUBLIC_*)
# ci_placeholders:  dict       — env var name → placeholder value for CI builds
# clean:
#   files:          list[str]  — files to delete on `make clean`
#   dirs:           list[str]  — directories to delete on `make clean`
# gitignore:        list[str]  — entries to add to .gitignore

assumes: []
packages:
  runtime: []
  dev: []
files: []
env:
  server: []
  client: []
ci_placeholders: {}
clean:
  files: []
  dirs: []
gitignore: []
---
# [Category]: [Technology Name]
> Used when experiment.yaml has `stack.[category]: [value]`
> Assumes: [other stack files this depends on, e.g., `framework/nextjs` — or "None"]

## Packages
```bash
npm install [runtime-packages]
npm install -D [dev-packages]
```

## Files to Create
<!-- If this stack creates no files (e.g., hosting/vercel), write "None — this stack provides deployment patterns only." so future authors know the omission is intentional. -->

### `src/lib/[filename].ts` — [Description]
```ts
// Starter code or key exports
```
- [Usage notes]

## Environment Variables
```
VARIABLE_NAME=description-or-example
```

## Patterns
- [How skills should use this technology]
- [Key conventions to follow]
- [What to import and where]

## Assumes
- [List stack files this depends on, e.g., `framework/nextjs` for Next.js-specific imports]
- [If truly generic, write "None"]

<!-- Optional sections — include when relevant: -->

## Security
- [Secrets handling]
- [Access control requirements]
- [Client vs server boundaries]

## Demo Mode
<!-- Add demo mode guards to all client factory functions so pages render
     during visual review (no real credentials at bootstrap time).

     Server-side: FIRST check for production misuse, THEN check for demo mode:
       if (process.env.DEMO_MODE === "true" && process.env.VERCEL === "1") {
         throw new Error("DEMO_MODE is not allowed in production");
       }
       if (process.env.DEMO_MODE === "true") return createDemoClient();
     The production guard uses `VERCEL === "1"` (injected by Vercel on all
     deployments) instead of `NODE_ENV === "production"` because `next start`
     sets NODE_ENV=production locally, which would block demo mode during
     visual review and verification. For non-Vercel hosting, replace with
     the provider's deployment indicator (e.g., `RAILWAY_ENVIRONMENT_NAME`).

     Client-side: check `process.env.NEXT_PUBLIC_DEMO_MODE === "true"` and
     return a mock client. Do NOT add a NODE_ENV guard — the demo flag alone
     is sufficient. NEXT_PUBLIC_ is required because Next.js inlines
     client env vars at build time.

     For Supabase-style chainable APIs (e.g., `from()`), use a Proxy-based mock:
       const chainable = (terminal) => new Proxy(() => terminal, {
         get: (_, prop) => {
           if (prop === "then") return (resolve) => resolve(terminal);
           if (prop === "single") return () => chainable({ data: null, error: null });
           return chainable(terminal);
         },
         apply: () => chainable(terminal),
       });
     The `then` trap returns a proper thenable so `await` resolves to the
     terminal value. The `single()` handler returns `{ data: null }` instead
     of the default array shape.

     For auth-like namespaces with many methods (e.g., `auth`), use a Proxy
     fallback so unknown methods return a safe default instead of crashing:
       auth: new Proxy(
         { getUser: () => ..., getSession: () => ... },  // known methods with specific return shapes
         { get: (target, prop) => prop in target ? target[prop] : () => Promise.resolve({ data: {}, error: null }) }
       );
     This avoids maintaining an explicit allowlist — any new SDK method
     (e.g., signInWithOAuth) automatically gets a safe no-op response.

     For simpler clients (Stripe, Resend), a plain object mock or early
     return is sufficient.

     DEMO_MODE is never added to env frontmatter or .env.example — it is
     only set by the visual scanner (visual-review.md), never by /verify
     or production deployments. -->

## Analytics Integration
- [Which experiment/EVENTS.yaml events this stack interacts with]
- [Where to fire them]

## PR Instructions
- [Post-merge setup steps for the user]
- [Environment variables to configure]
- [External service configuration]

<!-- Include the Deploy Interface section for hosting and database stack files.
     deploy.md and teardown.md reference these subsections by name.
     Omit this section for non-hosting/non-database stacks (analytics, payment, etc.). -->

## Deploy Interface

<!-- For hosting stacks, include all of these subsections: -->
<!-- ### Prerequisites -->
<!-- - install_check, install_fix, auth_check, auth_fix -->
<!-- ### Config Gathering -->
<!-- - CLI command to discover team/org, experiment.yaml field name -->
<!-- ### Project Setup -->
<!-- - Create/link project, connect GitHub -->
<!-- ### Domain Setup -->
<!-- - Add custom domain command, fallback behavior -->
<!-- ### Environment Variables -->
<!-- - Primary method (API or CLI), auth token location, fallback, verify command -->
<!-- ### Volume Setup (optional — only if the hosting provider supports persistent volumes) -->
<!-- - Create volume command, mount path -->
<!-- ### Deploy -->
<!-- - Production deploy command, how to extract deployment URL -->
<!-- ### Health Check -->
<!-- - URL pattern -->
<!-- ### Auto-Fix -->
<!-- - Env var verify command, re-set method, redeploy command -->
<!-- ### Teardown -->
<!-- - Remove domain command, remove project command, dashboard URL for manual fallback -->
<!-- ### Manifest Keys -->
<!-- - Provider-specific keys for deploy-manifest.json -->
<!-- ### Compatibility -->
<!-- - incompatible_databases: [], reason: "..." -->

<!-- For database stacks, include all of these subsections: -->
<!-- ### Prerequisites -->
<!-- - install_check, auth_check (empty for embedded databases like sqlite) -->
<!-- ### Config Gathering -->
<!-- - Required parameters (org, region, etc.), experiment.yaml field names -->
<!-- ### Provisioning -->
<!-- - Project creation, readiness polling, key extraction, link + migration commands -->
<!-- ### Hosting Requirements -->
<!-- - incompatible_hosting: [], volume_config: { needed: bool, mount_path, env_vars } -->
<!-- ### Auth Config (optional — only if the database provides auth services) -->
<!-- - Management API token discovery, auth redirect URL configuration -->
<!-- ### Teardown -->
<!-- - Pre-delete safety check, delete command, dashboard URL for manual fallback -->
<!-- ### Manifest Keys -->
<!-- - Provider-specific keys for deploy-manifest.json -->
