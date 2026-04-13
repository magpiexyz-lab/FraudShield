# STATE 5: FIX_DESIGN

**PRECONDITIONS:**
- Blast radius complete (STATE 4 POSTCONDITIONS met)
- Root-cause clustering complete if applicable (STATE 4b POSTCONDITIONS met)

**ACTIONS:**

#### 5a) Complexity assessment

Determine solve-reasoning depth:

```
solve_depth = "light"  # default
if blast_radius confirmed >= 3: solve_depth = "full"
if severity = HIGH: solve_depth = "full"
```

State the depth selection with rationale before proceeding.

#### 5a-ring) Ring classification

Determine Ring level based on files the fix will modify:

| Ring | Scope | solve_depth | Behavior |
|------|-------|-------------|----------|
| Ring 1 | Only `.claude/patterns/<skill>/state-*.md` | Keep existing logic (default light) | Normal fix flow |
| Ring 2 | `.claude/hooks/`, `.claude/scripts/`, `.claude/stacks/` | Force `"full"` | Normal fix flow with full depth |
| Ring 3 | `state-registry.json` structure or `CLAUDE.md` | N/A | Analysis-only — no fix designed |

**Ring 3 handling:**
- Output analysis report only (no `fix_plan`)
- In `solve-trace.json`, set `output` to: "Ring 3: requires architecture discussion — see analysis"
- In `resolve-context.json`, set `"ring": 3`
- After STATE 5d completes, skip STATEs 6-9a and jump directly to STATE 11 (commit-pr)


#### 5b-light) Light mode path

When `solve_depth = "light"`: call `.claude/patterns/solve-reasoning.md` light mode (Steps 1-5).

- Set `problem_type = "defect"` (resolve always handles defects)
- **Inputs**: `divergence_point`, `blast_radius`, `reproduction`, `severity` as constraints
- **Output mapping**:
  - "Recommended Solution" -> `root_cause`
  - "Implementation Steps" -> `fix_plan`
  - "Constraints Respected" -> constraint review
  - "Key Tradeoff" -> diagnosis report
  - "Prevention Analysis" -> `prevention_analysis` in solve-trace.json

#### 5b-full) Full mode path

When `solve_depth = "full"`: call `.claude/patterns/solve-reasoning.md` full mode (Phases 1-4). Phase 5 (critic) executes in STATE 5d.

- Set `problem_type = "defect"` (resolve always handles defects)
- **Phase 1 agent customization**:
  - Agent 1 = divergence investigation (trace the assumption violation, git blame context)
  - Agent 2 = blast radius + prior fix art (grep for the causal pattern broadly, find past fixes for similar patterns)
  - Agent 3 = fix constraints (validator compatibility, archetype universality, backwards compatibility)
- **Phase 3 gap resolution**: autonomous — AI self-answers research gaps using first-principles reasoning
- **Phase 5 Critic** (STATE 5d): domain-specific vectors configured in Step 5c below, executed in STATE 5d
- **Output mapping**:
  - "Recommended Solution" -> `root_cause` + `fix_plan`
  - "Constraint Space" -> hard constraints in diagnosis report
  - "Remaining Risks" TYPE B -> system constraints in diagnosis report
  - "Remaining Risks" TYPE C -> open questions in diagnosis report
  - "Remaining Risks" Caveats -> caveats in diagnosis report
  - "Prevention Analysis" -> `prevention_analysis` in solve-trace.json

#### 5c) Domain-specific post-validation

After solve-reasoning completes (either mode), apply template-specific validation.

**Core prevention** (handled by solve-reasoning `prevention_analysis`):
Root cause, regression prevention, and scope coverage are evaluated by the core
pattern via `problem_type = "defect"`. Do not re-check these — verify via
`prevention_analysis` field in solve-trace.json:
- `root_cause_addressed` must be true
- `recurrence_risk` must be "none" or "guarded" (if "unguarded", justification
  required in `recurrence_guard`)
- `scope.all_covered` must be true

If core prevention fails: iterate once through solve-reasoning self-check (light)
or flag for Phase 5 critic (full).

**Domain-specific requirement** (must be satisfied):
1. **Template universality**: Fix works for ALL experiment.yaml configurations
   (all archetypes, with/without optional stacks)

If template universality fails: iterate once.

Record: `root_cause`, `fix_plan` (per-file changes), `proposed_checks` (if any
from prevention_analysis.recurrence_guard).

- **Write solve trace artifact** (`.runs/solve-trace.json`) using the contract from solve-reasoning.md:
  ```bash
  python3 -c "
  import json
  trace = {
      'mode': '<light|full>',
      'problem_decomposition': '<divergence points and blast radius summary>',
      'constraint_enumeration': '<template universality, validator compat, backwards compat>',
      'solution_design': '<root_cause + fix_plan for each issue/cluster>',
      'self_check': '<revision pass results>',
      'output': '<recommended fix summary>',
      'prevention_analysis': {
          'problem_type': 'defect',
          'root_cause_addressed': True,
          'recurrence_risk': '<none|guarded|unguarded>',
          'recurrence_guard': '<description or null>',
          'scope': {
              'all_covered': True,
              'instance_count': 0
          }
      }
  }
  json.dump(trace, open('.runs/solve-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Each actionable issue (or cluster) has: `root_cause`, `fix_plan`, `proposed_checks`
- Core prevention (`prevention_analysis`) passed for all fixes
- Domain-specific template universality passed for all fixes
- `.runs/solve-trace.json` exists with required fields including `prevention_analysis`

**VERIFY:**
```bash
python3 -c "import json; st=json.load(open('.runs/solve-trace.json')); required=['mode','problem_decomposition','constraint_enumeration','solution_design','self_check','output']; missing=[k for k in required if k not in st]; assert not missing, 'solve-trace.json missing: %s' % missing; pa=st.get('prevention_analysis'); assert pa is not None, 'prevention_analysis required for resolve'; assert isinstance(pa, dict) and 'root_cause_addressed' in pa and 'recurrence_risk' in pa and 'scope' in pa, 'prevention_analysis incomplete'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 5
```

**NEXT:** Read [state-5d-adversarial-challenge.md](state-5d-adversarial-challenge.md) to continue.
