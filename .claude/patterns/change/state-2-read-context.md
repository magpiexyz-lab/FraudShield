# STATE 2: READ_CONTEXT

**PRECONDITIONS:**
- On `change/*` branch (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.

- Read `experiment/experiment.yaml` — understand the current scope, pages (derived from golden_path), existing behaviors, target user, thesis
- Read `experiment/EVENTS.yaml` — understand existing analytics events (this is the canonical event list)
- CALL: `.claude/archetypes/<type>.md` — read the archetype file (type from experiment.yaml, default `web-app`). Apply archetype behavior per `patterns/archetype-behavior-check.md`. (Key: web-app=pages+landing, service=API-only, cli=commands). Record key constraints extracted from the archetype.
- Resolve the stack: read experiment.yaml `stack`. For each category, read `.claude/stacks/<category>/<value>.md`. If a stack file doesn't exist for a given value, generate it: read `.claude/stacks/TEMPLATE.md` for the schema, read existing files in the same category as reference, and create `.claude/stacks/<category>/<value>.md` with complete frontmatter and code templates. Run `python3 scripts/validate-frontmatter.py` to verify (max 2 fix attempts). If validation fails, stop: "Could not generate a valid stack file for `<category>/<value>`. Create it manually using TEMPLATE.md as a guide." File an observation (REF: `.claude/patterns/observe.md`) for the missing stack file.
- Scan the codebase structure per archetype (path per framework stack file). Understand the current structure and codebase state.
- CALL: `.claude/procedures/plan-exploration.md` — **explore codebase for planning context**. Exploration depth depends on the change type — do a preliminary classification from $ARGUMENTS keywords (adds/creates/new → Feature depth, replaces/upgrades/integrate → Upgrade depth, fixes/broken/bug → Fix depth, polish/improve/visual → Polish depth, analytics/tracking → Analytics depth, test/spec/e2e → Test depth). Store results in working memory for Phase 1. If auto memory has a "Planning Patterns" section, read it and incorporate relevant patterns into the exploration.
- If `.runs/iterate-manifest.json` exists, read it for context. Validate it is valid JSON with keys `verdict`, `bottleneck`, `recommendations` before using. If malformed or missing required keys, warn: "iterate-manifest.json is incomplete — proceeding without iterate context." Otherwise:
  - Include the verdict, bottleneck, and recommendations in the plan (Phase 1)
  - Reference: "This change addresses the [bottleneck.stage] bottleneck identified by /iterate ([bottleneck.diagnosis])"
  - This provides continuity between analysis and implementation

- If `.runs/verify-context.json` exists and contains a `diagnostic` key, read it for prior failure context. This occurs when a previous `/verify` or `/bootstrap` run exhausted its BUILD_LINT_LOOP and the user is now running `/change "fix: ..."` to address it. Include in working memory:
  - Prior error category: `diagnostic.category`
  - Remaining errors: `diagnostic.last_errors`
  - What was already tried: `diagnostic.attempts`
  - This provides continuity: "Picking up from a prior failed build. Category: [category]. Previous attempts tried: [summary]. Remaining errors: [last_errors]."

- **Persist exploration results** to `change-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.runs/change-context.json'))
  ctx['preliminary_type'] = '<preliminary_type>'  # Feature|Upgrade|Fix|Polish|Analytics|Test
  ctx['affected_areas'] = <N>  # integer count of affected areas from exploration
  json.dump(ctx, open('.runs/change-context.json', 'w'))
  "
  ```

- **Write exploration trace artifact** (`.runs/exploration-trace.json`):
  ```bash
  python3 -c "
  import json
  trace = {
      'archetype': '<type field value from experiment.yaml>',
      'archetype_constraints': ['<key constraints extracted from archetype file>'],
      'stacks_read': ['framework/<value>', 'ui/<value>'],  # list of stack categories/values read
      'affected_files': ['<file paths discovered by plan-exploration>'],
      'affected_imports': ['<imports affected by the change>'],
      'exploration_steps_completed': [1, 5]  # which plan-exploration steps were executed
  }
  json.dump(trace, open('.runs/exploration-trace.json', 'w'), indent=2)
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
- `preliminary_type` and `affected_areas` persisted to `.runs/change-context.json`
- Diagnostic context from prior verify run read (if available)
- `.runs/exploration-trace.json` exists with required fields (`archetype`, `archetype_constraints`, `stacks_read`, `affected_files`, `affected_imports`, `exploration_steps_completed`)
- Files listed in `affected_files` exist on disk

**VERIFY:**
```bash
python3 -c "import json,os; d=json.load(open('.runs/exploration-trace.json')); required=['archetype','archetype_constraints','stacks_read','affected_files','affected_imports','exploration_steps_completed']; missing=[k for k in required if k not in d]; assert not missing,'exploration-trace.json missing: %s'%missing; bad=[f for f in d['affected_files'] if f and not os.path.exists(f)]; assert not bad,'affected_files not on disk: %s'%bad; ctx=json.load(open('.runs/change-context.json')); assert ctx.get('preliminary_type') is not None; assert isinstance(ctx.get('affected_areas'),int)"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 2
```

**NEXT:** Read [state-3-solve-reasoning.md](state-3-solve-reasoning.md) to continue.
