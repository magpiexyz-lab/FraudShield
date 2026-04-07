# STATE 6: STACK_FUNNEL

**PRECONDITIONS:**
- Variants approved (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

> **Archetype routing** (per `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table):
>
> | Concern | web-app | service | cli |
> |---------|---------|---------|-----|
> | Primary unit | page | endpoint | command |
> | Spec field | `golden_path` | `endpoints` | `commands` |
> | Skip | — | pages, landing, Fake Door | pages, API, landing, Fake Door |
> | Visual agents | full pipeline | skip | skip |
> | Analytics | client + server | server only | server only, opt-in |
>
> State-specific logic below takes precedence.

## Step 6: Assemble experiment.yaml

Build the complete experiment.yaml with these 7 sections:

### Section 1 — Identity
```yaml
name: <slugified-name>
owner: <team-or-user-slug>       # Derive from `gh repo view --json owner --jq '.owner.login'`, or ask user
type: web-app                    # web-app | service | cli
level: <selected level>
status: draft
quality: production              # Always active. TDD and spec-reviewer enabled.
```

### Section 2 — Intent
```yaml
description: |
  <2-3 sentences, refined from idea + research>

thesis: "<If [action], then [outcome], as measured by [metric]>"
target_user: "<Specific ICP>"

distribution: |
  <Channels from reach hypotheses>

hypotheses:
  <all from Step 3>
```
- `description` merges problem + solution into one field
- `thesis` is required
- `hypotheses` are inline under Intent

### Section 3 — Behaviors
```yaml
behaviors:
  <all from Step 4, with tests[] and optional actor/trigger>
```

### Section 4 — Journey
The golden_path and endpoints/commands from Step 4 (state-4-golden-path).

### Section 5 — Variants

**If type is `web-app`:**
```yaml
variants:
  <all from Step 5>
```

**If type is `service` or `cli`:** Omit the `variants` section entirely — variants (A/B landing page testing) are only supported for the web-app archetype.

### Section 6 — Funnel
Dimension thresholds are derived from the highest-priority hypothesis in each category (no per-dimension metric/threshold fields in the funnel itself).
```yaml
funnel:
  available_from:
    reach: L1
    demand: L1
    activate: L2
    monetize: L2
    retain: L3
  decision_framework:
    scale: "All tested dimensions >= 1.0"
    kill: "Any top-funnel (REACH or DEMAND) < 0.5"
    pivot: "2+ dimensions < 0.8"
    refine: "1+ dimensions < 1.0 but fewer than 2 below 0.8"
```

### Section 7 — Stack + Deploy
Stack is deterministic from level and archetype:

**If type is `web-app`:**

Level 1:
```yaml
stack:
  services:
    - name: app
      runtime: nextjs
      hosting: vercel
      ui: shadcn
      testing: playwright
  analytics: posthog
deploy:
  url: null
  repo: null
```

Level 2: Level 1 + `database: supabase`

Level 3: Level 2 + `auth: supabase` (and `payment: stripe` if monetize hypotheses exist)

**If type is `service`:**

Level 1:
```yaml
stack:
  services:
    - name: app
      runtime: hono
      hosting: railway
      testing: vitest
  analytics: posthog
deploy:
  url: null
  repo: null
```

Level 2: Level 1 + `database: supabase`

Level 3: Level 2 + `auth: supabase` (and `payment: stripe` if monetize hypotheses exist)

**If type is `cli`:**

Level 1:
```yaml
stack:
  services:
    - name: app
      runtime: commander
      testing: vitest
  analytics: posthog
deploy:
  url: null
  repo: null
```

Level 2: Level 1 + `database: sqlite`

Level 3: Level 2 (cli excludes auth and payment per archetype definition)

### CHECKPOINT

Present the assembled YAML in full. Then say:
> **Review the experiment specification above.**
>
> - Check that hypotheses match your intuition
> - Check that behaviors cover what you want to test
> - Check that variants feel genuinely different
> - Check that the stack matches your needs
>
> Reply **approve** to write the file, or tell me what to change.

**STOP.** Do NOT write any files until the user explicitly approves.

If the user requests changes, revise the YAML and present it again. Repeat until approved.

**POSTCONDITIONS:**
- Complete experiment.yaml assembled with all 7 sections
- User approved the specification

**VERIFY:**
```bash
grep -q 'stack:' experiment/experiment.yaml && grep -q 'funnel:' experiment/experiment.yaml
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh spec 6
```

**NEXT:** Read [state-7-output.md](state-7-output.md) to continue.
