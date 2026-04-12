# Scaffold: Library Files

## Prerequisites
- Packages installed and UI setup complete (Step 1 finished)
- Stack files on disk for all categories in experiment.yaml `stack`
- `.runs/current-plan.md` exists

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

## Instructions

Create ONLY the `src/lib/` files (and `src/middleware.ts` when `stack.auth` is present) from each stack file's "Files to Create" section. Skip files outside these paths — pages are owned by scaffold-pages, infrastructure routes and components by scaffold-wire.

1. **Analytics library** (if `stack.analytics` is present): create from the analytics stack file.

2. **Database clients** (if `stack.database` is present): create from the database stack file.

3. **Auth files** (if `stack.auth` is present): create from the auth stack file using the correct conditional path:
   - If `stack.database` matches the auth provider (e.g., both `supabase`): auth shares the database client files — create only `src/middleware.ts` (from the auth stack file's "Middleware" section)
   - If `stack.database` is absent or a different provider: create standalone auth library files from the "Standalone Client" section (e.g., `supabase-auth.ts`, `supabase-auth-server.ts`) AND `src/middleware.ts`
   - Do NOT create auth pages (signup, login), auth infrastructure (auth/callback, auth/reset-password), or components (nav-bar) — those are created by scaffold-pages and scaffold-wire respectively

4. **Auth before payment ordering**: if both `stack.auth` and `stack.payment` are present, create auth library files first — payment templates reference `user.id` which requires auth.

5. **Payment library files** (if `stack.payment` is present): create from the payment stack file's "Files to Create" section. Note: the payment stack file's checkout route template intentionally references `user.id` which is undefined until auth is integrated — this will cause a build error at the merged checkpoint that you must fix by adding the auth check (see the auth stack file's "Server-Side Auth Check" section). The webhook route template also contains a `// TODO: Update user's payment status in database` — unlike the auth check, this TODO compiles silently, so you must resolve it using the database schema planned in Phase 1.

6. **Analytics constant replacement** (if `stack.analytics` is present): replace placeholder constants in the analytics library files — replace `PROJECT_NAME = "TODO"` with the `name` from experiment.yaml and `PROJECT_OWNER = "TODO"` with the `owner` from experiment.yaml. For web-app: replace in both client (`src/lib/analytics.ts`) and server (`src/lib/analytics-server.ts`) files. For service/cli: replace in the server analytics file only (no client-side analytics). These constants auto-attach to every event — if left as TODO, experiment filtering will fail.

7. **CLI analytics consent wrapper** (if `stack.analytics` is present AND archetype is `cli`): read the analytics stack file's CLI Opt-In Consent section. Add the `isAnalyticsEnabled()` guard function to `src/lib/analytics-server.ts` and wrap `trackServerEvent()` so it returns early when consent is not given. Replace `<CLI_NAME>` with the uppercase experiment name from experiment.yaml. After writing the file, verify the guard exists: grep `src/lib/analytics-server.ts` for `isAnalyticsEnabled`. If missing, stop: "CLI analytics opt-in guard `isAnalyticsEnabled()` was not added to `src/lib/analytics-server.ts`. The CLI archetype requires opt-in consent for analytics (see `.claude/archetypes/cli.md`). Add it per the analytics stack file's CLI Opt-In Consent section before proceeding."

8. **Typed event wrappers** (if `stack.analytics` is present AND framework is `nextjs` AND archetype is `web-app`): generate `src/lib/events.ts` from experiment/EVENTS.yaml following the analytics stack file's generation rules. For each event in the EVENTS.yaml `events` map (filtered by `requires` matching experiment stack and `archetypes` matching experiment type): (a) generate a typed wrapper function named `track` + PascalCase(event_name) with props typed from the event's `properties` map, (b) the wrapper body calls `track(event_name, { ...props, funnel_stage: "<funnel_stage>" })` to auto-inject the event's funnel_stage. Also generate an `EVENT_FUNNEL_MAP` constant (`Record<string, string>`) mapping each event name to its funnel_stage. Pages should import from `events.ts` instead of calling `track()` directly with string event names. For non-Next.js frameworks (Hono, Commander) or non-web-app archetypes (service, cli), skip this step — only server-side analytics apply (see analytics stack file).

9. **Email events** (if `stack.email` is present): add to experiment/EVENTS.yaml `events` map:
   - `email_welcome_sent` (trigger: Welcome email sent after signup, properties: `recipient` string required)
   - `email_nudge_sent` (trigger: Activation nudge email sent by cron, properties: `recipient` string required, `days_since_signup` integer required)

10. **Write completion manifest**
   ```bash
   mkdir -p .runs/agent-traces
   ```
   Write `.runs/agent-traces/scaffold-libs.json`:
   ```json
   {"agent": "scaffold-libs", "files_created": ["<list all files created>"], "status": "complete", "timestamp": "<ISO 8601>"}
   ```
   This manifest gates Phase B2 agents via the skill-agent-gate hook.

