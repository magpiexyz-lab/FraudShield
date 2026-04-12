# STATE 3: SOLVE_REASONING

**PRECONDITIONS:**
- Context read (STATE 2 POSTCONDITIONS met)
- Preliminary classification determined from `$ARGUMENTS` keywords

**ACTIONS:**

Before classifying the change, run a structured solution design pass using
`.claude/patterns/solve-reasoning.md` with adaptive depth.

### Complexity assessment

Determine solve-reasoning depth using the preliminary classification from Step 2:

```
solve_depth = "light"  # default
if preliminary_type in [Feature, Upgrade] AND affected_areas >= 3:
    solve_depth = "full"
if $ARGUMENTS contains "--light":
    solve_depth = "light"  # user override
if $ARGUMENTS contains "--full":
    solve_depth = "full"   # user override
```

**Persist solve_depth** to `change-context.json`:
```bash
python3 -c "
import json
ctx = json.load(open('.runs/change-context.json'))
ctx['solve_depth'] = '<light|full>'  # result of the formula above
json.dump(ctx, open('.runs/change-context.json', 'w'))
"
```

State the depth selection with rationale. If the formula selects "full" but the affected
areas appear independent (no shared state, no shared imports), suggest to the user:
"3+ affected areas trigger full mode, but these areas look independent. Re-run with
`--light` if you want to skip deep analysis."

### Prevention activation

If `preliminary_type = "Fix"`: set `problem_type = "defect"` when calling solve-reasoning.
This activates the prevention dimension (root cause + recurrence + scope checks).

For all other preliminary_types: do not set `problem_type`.

### Light mode path

CALL: `.claude/patterns/solve-reasoning.md` — execute light mode (Steps 1-5).

- **Inputs**: `$ARGUMENTS` as problem, exploration results from Step 2 as constraints
- **Output**: stored in working memory, feeds into plan "How" sections in Phase 1

### Full mode path

CALL: `.claude/patterns/solve-reasoning.md` — execute full mode (Phases 1-6).

- **Phase 1 agent customization**:
  - Agent 1 = change problem space (what needs to change, for whom, and why)
  - Agent 2 = reuse/prior art (extends plan-exploration — find existing patterns, components, utilities that partially solve this)
  - Agent 3 = hard constraints (archetype restrictions, stack limitations, behavior scope from experiment.yaml)
- **Phase 3 gap resolution**: autonomous — AI self-answers research gaps using first-principles reasoning
- **Phase 5 Critic**: reviews plan mechanism choices (no extra domain vectors)
- **Output feeds**:
  - "Recommended Solution" + "Implementation Checklist" -> plan "How" sections
  - "Remaining Risks" -> Risks & Mitigations section
  - "Alternatives" -> Approaches table (if multi-layer Feature)
  - "Constraint Space" -> informs Step 3 classification and Step 4 prerequisite checks

### Write solve trace artifact

After completing the solve-reasoning pass (light or full), write `.runs/solve-trace.json`:
```bash
python3 -c "
import json
trace = {
    'mode': '<light|full>',
    'problem_decomposition': '<What/Why/Constraints summary>',
    'constraint_enumeration': '<executor/mechanisms/hard/soft constraints>',
    'solution_design': '<chosen mechanisms and rationale>',
    'self_check': '<revision pass results>',
    'output': '<recommended solution summary>'
}
# Add prevention_analysis only when preliminary_type is Fix
if preliminary_type == 'Fix':
    trace['prevention_analysis'] = {
        'problem_type': 'defect',
        'root_cause_addressed': True,
        'recurrence_risk': '<none|guarded|unguarded>',
        'recurrence_guard': '<description or null>',
        'scope': {'all_covered': True, 'instance_count': 0}
    }
json.dump(trace, open('.runs/solve-trace.json', 'w'), indent=2)
"
```

### Write challenge artifact

After completing the solve-reasoning pass, write `.runs/change-challenge.json`:

If `solve_depth = "full"`:
```bash
python3 -c "
import json
challenge = {
    'critic_rounds': 0,           # 1 or 2 — actual rounds executed
    'round_1_type_a_count': 0,    # TYPE A concerns from round 1
    'concerns': [
        # {'type': '<A|B|C>', 'description': '<text>'}
    ]
}
json.dump(challenge, open('.runs/change-challenge.json', 'w'), indent=2)
"
```

If `solve_depth = "light"` (no critic ran):
```bash
python3 -c "
import json
json.dump({'critic_rounds': 0, 'round_1_type_a_count': 0, 'concerns': []}, open('.runs/change-challenge.json', 'w'), indent=2)
"
```

**POSTCONDITIONS:**
- `solve_depth` determined and stated with rationale
- `solve_depth` persisted to `.runs/change-context.json` and matches formula
- Solve-reasoning pass completed (light or full)
- Output stored in working memory for plan generation
- `.runs/solve-trace.json` exists with 5 required fields (`mode`, `problem_decomposition`, `constraint_enumeration`, `solution_design`, `self_check`, `output`)
- `.runs/change-challenge.json` exists with `critic_rounds`, `round_1_type_a_count`, `concerns`

**VERIFY:**
```bash
python3 .claude/scripts/verify-change-solve.py  # change-context.json, solve-trace.json, change-challenge.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 3
```

**NEXT:** Read [state-4-classify.md](state-4-classify.md) to continue.
