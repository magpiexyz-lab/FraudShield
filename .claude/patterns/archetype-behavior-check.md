# Archetype Behavior Check

Product archetypes determine how capabilities map to code structure. When
scanning context, updating specs, implementing features, or scoping verification,
branch on the archetype from `experiment/experiment.yaml` `type` field
(default: `web-app`).

## Canonical Source Hierarchy

1. **CLAUDE.md Archetype-Feature Matrix** — feature inclusion/exclusion master (yes/no/conditional)
2. **`.claude/archetypes/<type>.md` frontmatter** — constraint master (required_stacks, excluded_stacks, required_experiment_fields)
3. **This file** — derived quick-lookup index for inline branching decisions

When this file and an archetype file disagree, the archetype file wins.

## Archetype Mapping

### web-app (default)

- **Capabilities map to**: pages derived from `golden_path`
- **Code structure**: `src/app/<page>/page.tsx` (one folder per page)
- **Includes**: landing page, Fake Door variants, CTA/conversion focus
- **Verification agents**: design-critic, ux-journeyer, design-consistency-checker (full visual pipeline)
- **Analytics**: client-side + server-side

### service

- **Capabilities map to**: API endpoints (route handlers)
- **Code structure**: `src/app/api/<endpoint>/route.ts`
- **Skip**: pages, landing page, Fake Door, golden_path
- **Spec field**: `endpoints` (not `golden_path`)
- **Verification agents**: skip design-critic, ux-journeyer, design-consistency-checker
- **Analytics**: server-side only

### cli

- **Capabilities map to**: subcommand modules
- **Code structure**: `src/commands/<command>.ts`
- **Skip**: pages, API routes, landing page, Fake Door, golden_path
- **Spec field**: `commands` (not `golden_path`)
- **Verification agents**: skip design-critic, ux-journeyer, design-consistency-checker
- **Analytics**: server-side only, must be opt-in (consent guard on `trackServerEvent`)

## Quick-Reference Table

> Canonical inline block — embed or reference this table in files with archetype branching.

| Concern | web-app | service | cli |
|---------|---------|---------|-----|
| Primary unit | page (`src/app/<page>/page.tsx`) | endpoint (`src/app/api/<ep>/route.ts`) | command (`src/commands/<cmd>.ts`) |
| Spec field | `golden_path` | `endpoints` | `commands` |
| Skip | — | pages, landing, Fake Door, golden_path | pages, API routes, landing, Fake Door, golden_path |
| Visual agents | design-critic, ux-journeyer, consistency-checker | skip | skip |
| Analytics | client + server | server only | server only, opt-in |
| Browser tests | Playwright | skip | skip |
| Trace field | `pages_wired` + `api_routes_wired` | `api_routes_wired` | `commands_wired` |
| Phase A (core scaffold) | run (layout, 404, error, favicon, OG, sitemap, robots, llms.txt) | skip | skip |
| Design tokens check | verify `--primary` in globals.css | skip | skip |
| Favicon + OG image check | verify icon.tsx + opengraph-image.tsx | skip | skip |
| Content/SEO checks | content quality, CTA, hrefs, tokens, SEO baseline | skip | skip |
| Performance + a11y agents | performance-reporter, accessibility-scanner | skip | skip |
| Consent guard | none | none | opt-in consent on `trackServerEvent` |
| npm cleanup on teardown | skip | skip | `npm deprecate` reminder |

> State-specific logic takes precedence over this summary.

## Compound Dimensions

These dimensions depend on archetype AND a secondary variable. The archetype
component is in the Quick-Reference Table; the compound condition must be
evaluated inline by consuming files.

### Surface type resolution (archetype + stack.surface + hosting)

1. If `stack.surface` is set explicitly in experiment.yaml → use it
2. If archetype `excluded_stacks` includes `hosting` → `detached`
3. If `stack.services[0].hosting` present → `co-located`
4. If `stack.services[0].hosting` absent → `none`

| archetype | excluded hosting | hosting present | surface |
|-----------|-----------------|-----------------|---------|
| web-app | no | yes | co-located |
| web-app | no | no | none |
| service | no | yes | co-located |
| service | no | no | none |
| cli | yes | — | detached |

### Deploy gate (archetype + surface)

| archetype | surface | result |
|-----------|---------|--------|
| web-app | co-located | full deploy |
| web-app | detached | surface-only deploy |
| service | co-located | full deploy (API health check) |
| service | none | stop — manual deploy required |
| cli | detached | surface-only deploy |
| cli | none | stop — use `npm publish` |

### Distribute gate (archetype + surface)

- surface = `none` → stop with archetype-specific guidance
- surface ≠ `none` → proceed regardless of archetype
- For CLI archetype, the surface URL IS the target URL

## Usage Points

This branching applies at four stages of every skill:

1. **Context scanning** (read-context states): scan pages, endpoints, or commands
   depending on archetype
2. **Spec updates** (update-specs states): update golden_path, endpoints, or
   commands field in experiment.yaml
3. **Implementation** (implement states): create page folders, API routes, or
   command modules; CLI analytics requires consent guard
4. **Verification** (verify states): scope visual agents to web-app only; skip
   design pipeline for service/cli
