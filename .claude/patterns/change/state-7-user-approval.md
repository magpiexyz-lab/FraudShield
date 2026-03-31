# STATE 7: USER_APPROVAL

**PRECONDITIONS:**
- Plan presented (STATE 6 POSTCONDITIONS met)

**ACTIONS:**

Follow checkpoint-resumption protocol per `patterns/checkpoint-resumption.md`.

### STOP. End your response here. Say:
> Plan ready. How would you like to proceed?
> 1. **approve** — continue implementation now
> 2. **approve and clear** — save plan, then clear context for a fresh start
> 3. **skip** — cancel this change and delete the feature branch
> 4. Or tell me what to change

DO NOT proceed to Phase 2 until the user explicitly replies with approval.
If the user selects "skip": run `git checkout main && git branch -D <branch-name>`, tell the user "Change cancelled. Branch deleted. Run `/change` again when ready." and stop.
If the user requests changes instead of approving, revise the plan to address their feedback and present it again. Repeat until approved.

Save the approved plan to `.claude/runs/current-plan.md` with YAML frontmatter:

```yaml
---
skill: change
type: [classification from Step 3]
scope: [verification scope from Step 3]
archetype: [from experiment.yaml type, default web-app]
branch: [current git branch name]
stack: { [category]: [value], ... }
checkpoint: phase2-gate
context_files:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - .claude/archetypes/[archetype].md
  - [each .claude/stacks/<category>/<value>.md read in Step 2]
acceptance_criteria:   # OPTIONAL — omit if no verifiable behaviors
  - id: AC1
    behavior: "<verifiable behavior extracted from plan body>"
    verify_method: behavior-verifier | unit-test
    test_file: "<relative path, only when verify_method is unit-test>"
  - id: AC2
    behavior: "..."
    verify_method: behavior-verifier
---
```

**Generating `acceptance_criteria`:** Before saving the plan, extract verifiable behaviors from the plan body:
- Scan "What I'll Add", "Bug Diagnosis", "Planned Changes", or equivalent sections for concrete, testable behaviors
- Each behavior becomes one AC entry with `id` format `AC1`, `AC2`, ...
- Choose `verify_method`: pure logic (sorting, calculations, data transforms) → `unit-test` + specify `test_file`; UI/page rendering, navigation, visual output → `behavior-verifier`
- Typical count: Feature 3-5 ACs, Fix 1-2, Polish 1-3
- If no verifiable behaviors can be extracted (rare), omit the `acceptance_criteria` field entirely

Then append the plan body. The frontmatter enables resume-after-clear without re-deriving classification, scope, or stack.

If the user replied **"approve and clear"** or **"2"**:
  1. Save the plan with frontmatter (same as above)
  2. Tell the user: "Plan saved. Run `/clear`, then re-run `/change [original $ARGUMENTS]`. I'll resume at the checkpoint."
  3. STOP — do NOT proceed to Phase 2.

**POSTCONDITIONS:**
- User has explicitly approved the plan (option 1 or 2)
- Plan saved to `.claude/runs/current-plan.md` with YAML frontmatter

**VERIFY:**
```bash
test -f .claude/runs/current-plan.md && head -1 .claude/runs/current-plan.md | grep -q '^\-\-\-' && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 7
```

**NEXT:**
- If user approved (option 1 / "approve"): Read [state-8-phase2-preflight.md](state-8-phase2-preflight.md) to continue.
- If user selected "approve and clear" (option 2): TERMINAL — plan saved, tell user to `/clear` and re-run `/change`.
