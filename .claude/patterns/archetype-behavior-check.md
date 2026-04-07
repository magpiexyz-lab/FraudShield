# Archetype Behavior Check

Product archetypes determine how capabilities map to code structure. When
scanning context, updating specs, implementing features, or scoping verification,
branch on the archetype from `experiment/experiment.yaml` `type` field
(default: `web-app`).

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

> State-specific logic takes precedence over this summary.

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
