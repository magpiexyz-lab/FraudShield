# experiment.yaml — Canonical Schema

The single source of truth for `experiment.yaml`. Every consumer (skills,
agents, gate-keeper, lint rules) reads from this file. Field semantics here
are authoritative — disagreement between consumers is a coherence violation
detected by `verify-linter.sh` (see `.claude/patterns/template-coherence-rules.json`).

> **Why this file exists:** Issue #1024 surfaced that `golden_path` was being
> consumed with three incompatible semantics across consumers. To prevent
> recurrence, every field in `experiment.yaml` is documented here with one
> well-defined semantic. Consumers cite this file by URL fragment.

## Top-level structure

```yaml
name: <string>             # Project slug (lowercase, hyphenated)
owner: <string>            # Team or user owning the experiment
type: web-app | service | cli   # Archetype (default: web-app)
level: 1 | 2 | 3           # Product depth (1: landing only, 2: + signup, 3: + payments)
status: draft | live | done

description: <multiline>
thesis: <one-sentence falsifiable claim>
target_user: <persona>
distribution: <multiline>

hypotheses: [...]
behaviors: [...]
golden_path: [...]         # web-app only
endpoints: [...]           # service only
commands: [...]            # cli only
variants: [...]
funnel: {...}
stack: {...}
target_geo: [...]
deploy: {...}
```

## Field reference

### `name` (required, string)

Lowercase project slug, used in analytics distinct-id and PR titles.

### `owner` (required, string)

Team or user identifier. Becomes `project_owner` in analytics events.

### `type` (optional, enum, default `web-app`)

Product archetype. Drives:
- File-structure: `src/app/<page>/page.tsx` (web-app), `src/app/api/` (service), `src/commands/` (cli)
- Required behavior fields: `pages` (web-app), `endpoints` (service), `commands` (cli)
- Gate-keeper checks (BG2)

### `behaviors` (required, list)

Each behavior is a user-observable capability tied to a hypothesis. Schema:

```yaml
- id: <string>                 # Required. Behavior identifier (b-01, b-02, ...)
  hypothesis_id: <string>      # Required. Hypothesis this behavior validates.
  given: <string>              # Required. Pre-condition.
  when: <string>               # Required. User/system action.
  then: <string>               # Required. Post-condition.
  tests: [<string>...]         # Required. Acceptance criteria.
  level: 1 | 2 | 3             # Required. Behavior level.
  actor: user | system | cron  # Optional. Default `user`.
  trigger: <string>            # Optional. Required when actor != user.

  # Archetype-conditional REQUIRED fields:
  pages: [<page>...]           # web-app + actor: user → REQUIRED, non-empty
  endpoints: [<endpoint>...]   # service → REQUIRED, non-empty
  commands: [<command>...]     # cli → REQUIRED, non-empty
```

#### `behavior.pages` (web-app + actor: user → REQUIRED)

The set of pages that the user interacts with during this behavior. **Every page
named here MUST be created** (gate-keeper BG2 check 3c enforces existence).

A behavior spans multiple pages when it crosses page boundaries — e.g., "user
clicks signup CTA on landing → fills form on signup page → lands on dashboard"
declares `pages: [landing, signup, dashboard]`.

**For `actor: system` or `actor: cron` behaviors**, `pages` is omitted (these
behaviors have no UI surface).

**For service archetype**, omit `pages`; use `endpoints` instead.

**For cli archetype**, omit `pages`; use `commands` instead.

#### Why `pages` is required

Before this requirement, pages were derived only from `golden_path`. Behaviors
referencing pages outside `golden_path` (e.g., `admin`, `dashboard`, `portfolio`)
got backend + RLS + tests scaffolded but their frontend pages were silently
blocked, causing 404 traps after deploy. Making `pages` required ensures every
user-facing behavior maps to a concrete frontend page that gets scaffolded.

### `golden_path` (web-app required, list)

Ordered list of user journey steps used for funnel analytics, sequence-based
consumers (nav-bar order, funnel tests, sitemap order). Each step:

```yaml
- step: <string>          # Required. Human-readable description.
  event: <event_id>       # Required. Maps to experiment/EVENTS.yaml.
  page: <page>            # Required. Page where this step occurs.
```

`golden_path` is the **funnel sequence**, not the page inventory. Pages outside
`golden_path` still exist if declared in `behavior.pages`. The canonical page
inventory is the union of `golden_path[*].page`, `behaviors[*].pages`, and
auth-derived pages.

### `endpoints` (service required, list)

Service archetype only. Each endpoint:

```yaml
- method: GET | POST | PUT | DELETE
  path: /api/<route>
  purpose: <string>
```

### `commands` (cli required, list)

CLI archetype only. Each command:

```yaml
- name: <command_name>
  args: [<arg>...]
  purpose: <string>
```

### `hypotheses` (required, list)

```yaml
- id: <string>           # h-01, h-02, ...
  category: demand | activate | monetize | retain | reach
  statement: <falsifiable claim>
  metric:
    formula: <events / events>
    threshold: <number>
    operator: gte | lte | eq
  priority_score: 0..100
  experiment_level: 1 | 2 | 3
  depends_on: [<hypothesis_id>...]
  status: pending | testing | confirmed | rejected
```

### `variants` (required, list)

A/B messaging variants. Each:

```yaml
- slug: <string>                # Variant identifier (used in /v/<slug> route)
  headline: <string>
  subheadline: <string>
  cta: <string>
  promise: <string>
  proof: <string>
  urgency: <string>
  pain_points: [<string>...]
```

### `stack` (required, dict)

```yaml
stack:
  services:
    - name: <string>
      runtime: nextjs | express | hono
      hosting: vercel | fly | aws-lambda
      ui: shadcn | none
      testing: playwright | vitest
  database: supabase | postgres | none
  auth: supabase | none
  auth_providers: [<provider>...]
  analytics: posthog | none
  payment: stripe | none
  surface: co-located | detached | none   # service/cli only — landing page strategy
```

### `funnel` (required, dict)

```yaml
funnel:
  available_from:
    reach: L1 | L2 | L3
    demand: L1 | L2 | L3
    activate: L2 | L3
    monetize: L2 | L3
    retain: L3
  decision_framework:
    scale: <condition>
    kill: <condition>
    pivot: <condition>
    refine: <condition>
```

### `target_geo` (required, list)

ISO country codes for ad targeting. Used by `/distribute`.

### `deploy` (optional, dict)

Populated by `/deploy`:

```yaml
deploy:
  url: <https url>
  repo: <github org/repo>
  domain: <custom domain>
```

## Page Inventory Derivation

The canonical page set is computed by `derive_scope_pages()` in
`.claude/scripts/lib/derive_pages.py`:

```
pages = (golden_path[*].page where present)
      ∪ (behaviors[*].pages where archetype is web-app)
      ∪ (auth-derived: login, signup if stack.auth is set)
      \ {None, empty, "landing"}   # landing is owned by scaffold-landing, not scaffold-pages
```

Consumers that need this set MUST call `derive_scope_pages()` (not raw `golden_path`):

- `.claude/skills/bootstrap/state-11b-page-scaffold.md` — spawn list
- `.claude/agents/gate-keeper.md` BG2 check 3b — page count cap
- `.claude/agents/gate-keeper.md` BG2 check 3c — behavior page existence
- `.claude/procedures/scaffold-pages.md` — sitemap generation
- `.claude/stacks/auth/supabase.md` — public path declaration

Consumers that need ordered funnel steps (nav order, funnel tests) call
`derive_funnel_steps()` instead — these access `golden_path` ordering directly.

## Archetype Matrix

| Field | web-app | service | cli |
|---|---|---|---|
| `golden_path` | required | omit | omit |
| `endpoints` | omit | required | omit |
| `commands` | omit | omit | required |
| `behavior.pages` | required (actor: user) | omit | omit |
| `behavior.endpoints` | omit | required | omit |
| `behavior.commands` | omit | omit | required |
| `stack.surface` | n/a | optional (landing strategy) | optional (landing strategy) |

## Migration

Existing experiments (created before `behavior.pages` became required) are
backfilled by `.claude/scripts/migrate-experiment-yaml.py`, which `/upgrade`
invokes as sub-step 1c. The migration helper:

- Skips non-web-app archetypes (`migration_status: not-applicable`)
- Suggests pages from heuristic scan of `behavior.given/when/then` text
- Constrains candidates to pages that already exist as `src/app/<name>/page.tsx`
- Tags suggestions `REQUIRES_USER_REVIEW`; never auto-applies
- Logs to `.runs/upgrade-migration-applied.json`
