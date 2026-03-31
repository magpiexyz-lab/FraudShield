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

#### 5b-light) Light mode path

When `solve_depth = "light"`: call `.claude/patterns/solve-reasoning.md` light mode (Steps 1-5).

- **Inputs**: `divergence_point`, `blast_radius`, `reproduction`, `severity` as constraints
- **Output mapping**:
  - "Recommended Solution" -> `root_cause`
  - "Implementation Steps" -> `fix_plan`
  - "Constraints Respected" -> `anti_pattern_review`
  - "Key Tradeoff" -> diagnosis report

#### 5b-full) Full mode path

When `solve_depth = "full"`: call `.claude/patterns/solve-reasoning.md` full mode (Phases 1-6).

- **Phase 1 agent customization**:
  - Agent 1 = divergence investigation (trace the assumption violation, git blame context)
  - Agent 2 = blast radius + prior fix art (grep for the causal pattern broadly, find past fixes for similar patterns)
  - Agent 3 = fix constraints (validator compatibility, archetype universality, backwards compatibility)
- **Phase 3 gap resolution**: autonomous — AI self-answers research gaps using first-principles reasoning
- **Phase 5 Critic**: receives domain-specific vectors (see Step 5c below)
- **Output mapping**:
  - "Recommended Solution" -> `root_cause` + `fix_plan`
  - "Constraint Space" -> hard constraints in diagnosis report
  - "Remaining Risks" TYPE B -> system constraints in diagnosis report
  - "Remaining Risks" TYPE C -> open questions in diagnosis report
  - "Remaining Risks" Caveats -> caveats in diagnosis report

#### 5c) Domain-specific post-validation

After solve-reasoning completes (either mode), apply template-specific validation:

**Fix requirements** (all must be satisfied):
1. **Root cause**: Fix addresses the underlying cause, not just the symptom
2. **Blast radius coverage**: All instances from Step 4 are fixed, not just the
   reported one
3. **Regression prevention**: If the pattern can recur, propose a validator check
   (with target script, check name, pass/fail criteria)
4. **Template universality**: Fix works for ALL experiment.yaml configurations
   (all archetypes, with/without optional stacks)
5. **Simplest correct solution**: Minimum change that satisfies requirements 1-4

**Anti-patterns** (reject fixes that fall into these):
- **Band-aid**: Fixes the symptom but not the root cause
- **Over-engineering**: Adds abstraction or framework beyond what the fix needs
- **Narrow fix**: Only fixes the reported instance, ignores blast radius
- **No prevention**: Fixes the bug but adds no guard against recurrence

If validation rejects the solution:
- **Light mode**: iterate once through solve-reasoning Step 4 (Self-Check)
- **Full mode**: iterate once through Phase 5 critic round 2

Record: `root_cause`, `fix_plan` (per-file changes), `proposed_checks` (if any),
`anti_pattern_review` (confirm none apply).

- **Write solve trace artifact** (`.claude/runs/solve-trace.json`) using the contract from solve-reasoning.md:
  ```bash
  python3 -c "
  import json
  trace = {
      'mode': '<light|full>',
      'problem_decomposition': '<divergence points and blast radius summary>',
      'constraint_enumeration': '<template universality, validator compat, backwards compat>',
      'solution_design': '<root_cause + fix_plan for each issue/cluster>',
      'self_check': '<anti_pattern_review results>',
      'output': '<recommended fix summary>'
  }
  json.dump(trace, open('.claude/runs/solve-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Each actionable issue (or cluster) has: `root_cause`, `fix_plan`, `proposed_checks`, `anti_pattern_review`
- Domain-specific post-validation passed for all fixes
- `.claude/runs/solve-trace.json` exists with required fields

**VERIFY:**
```bash
test -f .claude/runs/solve-trace.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 5
```

**NEXT:** Read [state-5d-adversarial-challenge.md](state-5d-adversarial-challenge.md) to continue.
