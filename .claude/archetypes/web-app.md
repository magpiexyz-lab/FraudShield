---
description: "Web application with browser-based pages, UI components, and user authentication"
required_stacks: [framework, hosting]
optional_stacks: [database, auth, analytics, ui, payment, email, testing]
excluded_stacks: []
required_experiment_fields: [golden_path]
build_command: "npm run build"
---

# Web App Archetype

Browser-based application with URL-routed pages, UI components, and optional
user authentication. This is the default archetype when `type` is absent from
experiment.yaml.

## Structure

Each experiment.yaml `golden_path` entry with a `page` field maps to a route folder:

```
src/app/<page-name>/page.tsx
```

Pages are React components rendered in the browser. The landing page
(`golden_path` must include an entry with `page: landing`) is the public entry point.

## Funnel

Events are defined in experiment/EVENTS.yaml with `funnel_stage` tags. Filter by `requires` and `archetypes` fields based on experiment stack.

Standard web funnel events:
1. `visit_landing` (reach) — user loads the landing page
2. `signup_start` (demand) — user begins the signup flow
3. `signup_complete` (demand) — user finishes signup
4. `activate` (activate) — user completes the core action for the first time
5. `retain_return` (retain) — user returns after initial activation

Payment events (`pay_start`, `pay_success`) have `requires: [payment]` in experiment/EVENTS.yaml and are included when `stack.payment` is present in experiment.yaml.

## Conventions

- When `stack.analytics` is configured, every page fires analytics events per experiment/EVENTS.yaml
- Landing page is required — `validate-experiment.py` enforces this
- UI components come from the configured UI stack (e.g., shadcn/ui)
- API routes live under `src/app/api/` for mutations and server-side logic
- Database access uses RLS (Row-Level Security) when auth is configured
- layout.tsx exports `metadata` (title, description, OG tags) — derived per messaging.md Section E
- `src/app/sitemap.ts`, `src/app/robots.ts`, and `public/llms.txt` generated at bootstrap
- JSON-LD `WebApplication` schema embedded in layout.tsx
- Variant pages export per-page `generateMetadata()` with variant-specific title/description
