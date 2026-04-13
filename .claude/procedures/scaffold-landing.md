# Scaffold: Landing Page

## Prerequisites
- Branch already created (by bootstrap Step 0)
- Step 1 complete (theme tokens in `src/app/globals.css`, visual brief at `.runs/current-visual-brief.md`)
- `.runs/current-plan.md` exists

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

## Instructions

Resolve the surface type: if `stack.surface` is set in experiment.yaml, use it.
Otherwise infer: `stack.services[0].hosting` present → `co-located`; absent → `detached`.
Read the surface stack file at `.claude/stacks/surface/<value>.md`.

- **surface: none**: report "surface: none — no landing page needed" and stop.

**All other cases**: generate a world-class landing page.

### 1. Design decisions

Read the visual language brief from `.runs/current-visual-brief.md`. Do NOT
re-derive constraints — the brief contains the canonical design decisions
(color direction, philosophy, optimization target, palette, typography,
animation, spacing, component style, texture, and social proof treatment). Also read the theme tokens
from `src/app/globals.css` and tailwind config (already set in Step 1).

### 2. Apply frontend-design methodology

Apply the preloaded `frontend-design` guidelines (injected via skills) with:
- The three derived constraints
- The quality bar from design.md: "Create a world-class, conversion-optimized
  landing page. The visual quality must match a $50K agency page — not
  adequate, exceptional."
- The full content of experiment.yaml (product context)
- Copy derivation rules from messaging.md Section A (headline = outcome for
  target_user, CTA = action verb + outcome)
- Content inventory from messaging.md Section B (raw material, not structure)

If `frontend-design` guidelines are not available: use your own judgment —
match the product's personality, follow design.md quality bar, and apply
messaging.md content derivation rules. Do not stop or wait.

### 3. Generate the page

Use the frontend-design output to build the landing page. Technical context
varies by archetype:

**web-app + co-located** (React component):
- Include: theme tokens (globals.css custom properties, tailwind config from
  Step 1), available shadcn/ui components, framework page conventions from
  framework stack file. Import analytics functions from `src/lib/events.ts`
  (created by scaffold-libs in Phase B1, which completes before this agent
  launches in Phase B2)
- Read `.runs/image-manifest.json` for generated images. Use the hero image
  (`/images/hero.webp` or `/images/hero.svg`) in the hero section and feature
  images (`/images/feature-{1,2,3}.webp` or `.svg`) in feature sections.
  For `.webp` files use `next/image` `Image` component; for `.svg` files use
  `<img>` tags. These paths are guaranteed to exist from Phase B1.
- If no `variants`: write `src/app/page.tsx` — a complete React landing
  page component. Must fire `visit_landing` on mount with experiment/EVENTS.yaml properties.
- If `variants`: write `src/components/landing-content.tsx` — a shared
  `LandingContent` component that accepts variant props (headline, subheadline,
  cta, pain_points). Features section is shared across variants (from experiment.yaml
  `behaviors`). The structural routing files (variants.ts, root page, dynamic
  route) are created by the pages subagent in Phase B2 — they exist
  when both agents run.

**service + co-located** (self-contained HTML):
- Include: surface stack file content (route path, analytics wiring, CSS approach)
- Write the route handler file at [path from framework stack file]
  returning a complete self-contained HTML page

**cli + detached** (self-contained HTML):
- Include: surface stack file content (file path, CSS approach)
- Write `site/index.html` as a complete self-contained HTML page

### 3b. Structured data

Generate a JSON-LD `<script type="application/ld+json">` block for the landing page:
- Schema.org type per archetype: `WebApplication` (web-app), `WebAPI` (service), `SoftwareApplication` (cli)
- Properties: `name` (display name per messaging.md Section E), `description` (meta description per Section E), `url` (from deploy manifest `canonical_url`, or `/` if not yet deployed)
- For web-app: embed in layout.tsx body. For service/cli: embed in the inline HTML `<head>`

### 4. Wire analytics

If `stack.analytics` is present and not already included:
- For web-app: verify analytics per `patterns/analytics-verification.md`
- For service/cli: add inline snippet per surface stack file's analytics section

> **Note:** Visual rendering review (screenshots, layout breaks, mobile responsiveness)
> is performed by the design-critic agent in `/verify` (web-app only). Scaffold agents
> are responsible for code-level quality via the Persuasion Self-Check above.

> **Note:** Build verification occurs at the merged checkpoint (STATE 13), after all
> subagents complete. Do not run `npm run build` here — other subagents may still
> be writing files that affect the build.

## Trace Output

After all landing page tasks complete, write trace to `.runs/agent-traces/scaffold-landing.json`:

```bash
python3 -c "
import json, datetime, os
os.makedirs('.runs/agent-traces', exist_ok=True)
trace = {'agent': 'scaffold-landing', 'status': 'complete', 'timestamp': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'files_created': ['<list all files created or modified>']}
json.dump(trace, open('.runs/agent-traces/scaffold-landing.json', 'w'))
"
```

