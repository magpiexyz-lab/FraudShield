# STATE 6: PRESENT_PLAN

**PRECONDITIONS:**
- Preconditions passed (STATE 5 POSTCONDITIONS met)
- Classification and verification scope determined
- Solve-reasoning output available in working memory

**ACTIONS:**

DO NOT write any code, create any files, or run any install commands during this phase.

Present the plan using the template for the classified type from `.claude/procedures/change-plans.md`. Populate "How" sections using exploration results from Step 2.

**Validate the plan against the codebase**: Before presenting the plan to the user, follow `.claude/procedures/plan-validation.md`. If validation flags conflicts, adjust the plan or add items to the Questions section prefixed with "[Validation]".

**Plan structure validation** (before presenting for approval):
- Feature plans classified as Multi-layer: verify `## Approaches` section exists
- All plans: if `.claude/iterate-manifest.json` exists, verify the plan's Why section references the iterate bottleneck
- Production plans: verify each task with business logic has a specification test in its description
- All plans: verify `## Exploration Summary` section exists (shows files scanned, patterns found, conflicts detected)
If validation fails, fix the plan before presenting.

- **G2 Plan Gate**: Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute G2 Plan Gate. Verify: on a feature branch (not main), current-plan.md exists with YAML frontmatter, classification is one of [Feature/Upgrade/Fix/Polish/Analytics/Test], verification scope matches classification, no source code files modified yet (only .claude/ and experiment/ files), plan contains '## Exploration Summary' section." If gate-keeper returns BLOCK, fix blocking items before presenting plan.

**Full mode STOP augmentation**: If `solve_depth = "full"` in Step 2b, prepend
to the approval prompt:

> **Open questions from deep analysis:**
> [Phase 5 TYPE C concerns — assumptions only the user can validate]

**Plan display requirement**: Display the plan body (all sections from the type-specific
template — "What I'll Add" / "Bug Diagnosis" / "Planned Changes" / etc. through "Questions")
in your response text ABOVE the STOP prompt below. The user must be able to read the full
plan without requesting it separately. Do NOT include the YAML frontmatter (that is for
machine consumption only). If the plan exceeds 100 lines, include a summary table of
contents at the top.

**POSTCONDITIONS:**
- Plan generated from type-specific template
- Plan validated against codebase (plan-validation.md)
- Plan structure validation passed
- G2 Plan Gate passed
- Plan displayed to user in response text

**VERIFY:**
```bash
echo "Plan presented to user — awaiting approval"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 6
```

**NEXT:** Read [state-7-user-approval.md](state-7-user-approval.md) to continue.
