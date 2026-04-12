# STATE 6: STACK_FUNNEL

**PRECONDITIONS:**
- Variants approved (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
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

### Section 8 — Events (EVENTS.yaml)

Derive project-specific analytics events from golden_path, behaviors, and hypothesis formulas. There are NO standard/template events — every project defines its own events. `funnel_stage` is the only cross-MVP standardization layer.

**Derivation algorithm:**

1. **From golden_path**: each step's `event:` field → one event entry
2. **From hypothesis formulas**: extract all event names referenced in `metric.formula` fields (e.g., `user_signup / landing_view` → `user_signup`, `landing_view`). Ensure each appears in the event set.
3. **From behaviors**: scan `then` clauses for additional observable actions not yet covered. Derive event names using `<object>_<action>` snake_case convention.
4. **Assign funnel_stage**: derive from the hypothesis category that references each event (reach → reach, demand → demand, etc.). If an event is referenced by multiple hypotheses, use the earlier funnel stage.
5. **Assign trigger**: derive from the behavior's `then` clause or golden_path step description.
6. **Variant property**: if the experiment has `variants` and the first golden_path event is a landing page event, add a `variant` property (type: string, required: false) to that event.
7. **Payment events**: if `stack.payment` is present, derive payment-related events from monetize hypotheses and behaviors. Add `requires: [payment]` to those events.
8. **Archetype-specific events**: if type is `service`, add `archetypes: [service]` to API-specific events. If `cli`, add `archetypes: [cli]` to command-specific events.

**Generate EVENTS.yaml structure:**
```yaml
global_properties:
  project_name:
    description: From experiment.yaml `name` field. Identifies which experiment this data belongs to.
    type: string
    required: true
  project_owner:
    description: From experiment.yaml `owner` field. Identifies who owns this experiment.
    type: string
    required: true

events:
  <derived events in funnel_stage order: reach → demand → activate → monetize → retain>
```

Present the derived EVENTS.yaml alongside experiment.yaml for review.

### CHECKPOINT

Present the assembled experiment.yaml and EVENTS.yaml in full. Then say:
> **Review the experiment specification and analytics events above.**
>
> - Check that hypotheses match your intuition
> - Check that behaviors cover what you want to test
> - Check that variants feel genuinely different
> - Check that the stack matches your needs
> - Check that analytics events cover the key actions you want to measure
>
> Reply **approve** to write the files, or tell me what to change.

**STOP.** Do NOT write any files until the user explicitly approves.

If the user requests changes, revise the YAML and/or events and present again. Repeat until approved.

**POSTCONDITIONS:**
- Complete experiment.yaml assembled with all 7 sections
- Complete EVENTS.yaml derived from golden_path, behaviors, and hypotheses
- User approved the specification and events <!-- enforced by agent behavior, not VERIFY gate -->

**VERIFY:**
```bash
python3 -c "import yaml; d=yaml.safe_load(open('experiment/experiment.yaml')); assert d.get('name'), 'name missing'; assert d.get('type'), 'type missing'; assert d.get('thesis'), 'thesis missing'; assert d.get('behaviors'), 'behaviors missing'; gp=d.get('golden_path') or d.get('endpoints') or d.get('commands'); assert gp, 'no golden_path/endpoints/commands'; assert d.get('stack'), 'stack missing'; assert d.get('funnel'), 'funnel missing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh spec 6
```

**NEXT:** Read [state-7-output.md](state-7-output.md) to continue.
