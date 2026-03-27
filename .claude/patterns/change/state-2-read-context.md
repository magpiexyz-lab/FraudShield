# STATE 2: READ_CONTEXT

**PRECONDITIONS:**
- On `change/*` branch (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

Follow archetype behavior check per `patterns/archetype-behavior-check.md`.

- Read `experiment/experiment.yaml` — understand the current scope, pages (derived from golden_path), existing behaviors, target user, thesis
- Read `experiment/EVENTS.yaml` — understand existing analytics events (this is the canonical event list)
- Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`). Apply archetype behavior per `patterns/archetype-behavior-check.md`. (Key: web-app=pages+landing, service=API-only, cli=commands)
- Resolve the stack: read experiment.yaml `stack`. For each category, read `.claude/stacks/<category>/<value>.md`. If a stack file doesn't exist for a given value, generate it: read `.claude/stacks/TEMPLATE.md` for the schema, read existing files in the same category as reference, and create `.claude/stacks/<category>/<value>.md` with complete frontmatter and code templates. Run `python3 scripts/validate-frontmatter.py` to verify (max 2 fix attempts). If validation fails, stop: "Could not generate a valid stack file for `<category>/<value>`. Create it manually using TEMPLATE.md as a guide." File an observation per `.claude/patterns/observe.md` for the missing stack file.
- Scan the codebase structure per archetype (path per framework stack file). Understand the current structure and codebase state.
- **Explore codebase for planning context**: Follow `.claude/procedures/plan-exploration.md`. Exploration depth depends on the change type — do a preliminary classification from $ARGUMENTS keywords (adds/creates/new → Feature depth, replaces/upgrades/integrate → Upgrade depth, fixes/broken/bug → Fix depth, polish/improve/visual → Polish depth, analytics/tracking → Analytics depth, test/spec/e2e → Test depth). Store results in working memory for Phase 1. If auto memory has a "Planning Patterns" section, read it and incorporate relevant patterns into the exploration.
- If `.claude/iterate-manifest.json` exists, read it for context. Validate it is valid JSON with keys `verdict`, `bottleneck`, `recommendations` before using. If malformed or missing required keys, warn: "iterate-manifest.json is incomplete — proceeding without iterate context." Otherwise:
  - Include the verdict, bottleneck, and recommendations in the plan (Phase 1)
  - Reference: "This change addresses the [bottleneck.stage] bottleneck identified by /iterate ([bottleneck.diagnosis])"
  - This provides continuity between analysis and implementation

- If `.claude/verify-context.json` exists and contains a `diagnostic` key, read it for prior failure context. This occurs when a previous `/verify` or `/bootstrap` run exhausted its BUILD_LINT_LOOP and the user is now running `/change "fix: ..."` to address it. Include in working memory:
  - Prior error category: `diagnostic.category`
  - Remaining errors: `diagnostic.last_errors`
  - What was already tried: `diagnostic.attempts`
  - This provides continuity: "Picking up from a prior failed build. Category: [category]. Previous attempts tried: [summary]. Remaining errors: [last_errors]."

- **Persist exploration results** to `change-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.claude/change-context.json'))
  ctx['preliminary_type'] = '<preliminary_type>'  # Feature|Upgrade|Fix|Polish|Analytics|Test
  ctx['affected_areas'] = <N>  # integer count of affected areas from exploration
  json.dump(ctx, open('.claude/change-context.json', 'w'))
  "
  ```

**POSTCONDITIONS:**
- `experiment/experiment.yaml` read and understood
- `experiment/EVENTS.yaml` read and understood
- Archetype file read
- Stack files resolved and read
- Codebase structure scanned
- Exploration results stored in working memory
- Preliminary classification determined from `$ARGUMENTS` keywords
- `preliminary_type` and `affected_areas` persisted to `.claude/change-context.json`
- Diagnostic context from prior verify run read (if available)

**VERIFY:**
```bash
test -f experiment/experiment.yaml && test -f experiment/EVENTS.yaml && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 2
```

**NEXT:** Read [state-3-solve-reasoning.md](state-3-solve-reasoning.md) to continue.
