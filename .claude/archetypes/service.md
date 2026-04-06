---
description: "Backend service with API endpoints, no browser UI"
required_stacks: [framework, hosting]
optional_stacks: [database, auth, analytics, payment, email, testing]
excluded_stacks: [ui]
required_experiment_fields: [endpoints]
build_command: "npm run build"
---

# Service Archetype

Backend service that handles API requests with no browser-based UI.
The primary unit of work is the **endpoint** (not the page). Use this
archetype when `type: service` is set in experiment.yaml.

## Structure

Each experiment.yaml `endpoints` entry maps to an API route:

```
src/app/api/<endpoint>/route.ts
```

There are no page folders, no landing page, no UI components, and no
`src/components/` directory. The `ui` stack category is excluded.

Surface type is inferred by bootstrap when `stack.surface` is not set (evaluated in order — first match wins):
1. If the experiment defines no `golden_path` **and** no behavior describes a user-facing HTML page (all behaviors are pure API with no user-facing surface): surface is `none`. This applies regardless of whether hosting is configured — a pure API service has no landing page.
2. If the experiment has user-facing behaviors or golden_path: `stack.services[0].hosting` present → `co-located` (root URL serves a marketing page alongside API routes); hosting absent → `detached` (separate static marketing site).
When in doubt, set `stack.surface` explicitly in experiment.yaml to override inference.

When surface is `co-located` (the most common default), the root URL (`/`) serves
an HTML marketing page — see `.claude/stacks/surface/co-located.md`. API endpoints
live under `/api/*`.

### SEO/AEO (surface only)
- Root route handler's inline HTML must include `<meta>` tags: title, description, `og:title`, `og:description` — derived per messaging.md Section E
- JSON-LD with `WebAPI` type in inline HTML `<head>`
- `llms.txt` served via route handler (`src/app/llms.txt/route.ts`) returning `text/plain` — content per messaging.md Section E

## Funnel

Events are defined in experiment/EVENTS.yaml with `funnel_stage` tags. Filter by `requires` and `archetypes` fields based on experiment stack. The `api_call` event has `archetypes: [service]` — include it for service experiments.

When a surface is configured (default: `co-located`), `visit_landing` fires on the surface — providing a complete acquisition → activation → retention funnel.

Surface events (fired by the HTML surface page, not the API):
1. `visit_landing` (reach) — user loads the surface page at the root URL

Product events (suggestions, not requirements):
1. `api_call` (reach, `archetypes: [service]`) — a request hits an endpoint
2. `activate` (activate) — user completes the core action via the API
3. `retain_return` (retain) — user makes a request after 24+ hours since last call

Surface events use an inline analytics snippet (see analytics stack file and surface stack file). Product events use `trackServerEvent()` from the server analytics library.

## Testing

Services use unit and API tests (e.g., Vitest, Jest), not browser-based
E2E tests (Playwright). The test runner comes from the testing stack file.

## Deploy

Deployment follows the hosting stack file. For services, browser-based
health checks don't apply — use the `/api/health` endpoint instead.

## Distribution

When a surface is configured (default: `co-located`), the root URL serves
a marketing page. `/distribute` generates ad campaigns pointing to this URL.
This gives services the same distribution capability as web-apps — paid ads,
social campaigns, and tracked referral links all point to the surface.

When surface is `none`: distribution is direct outreach, documentation links,
or API marketplace listings.

## Conventions

- When `stack.analytics` is configured, every endpoint fires analytics events per experiment/EVENTS.yaml (server-side)
- No landing page requirement — `validate-experiment.py` skips landing checks
- No UI components — the `ui` stack category is excluded
- Database access uses RLS (Row-Level Security) when auth is configured
- API routes live directly under `src/app/api/`
