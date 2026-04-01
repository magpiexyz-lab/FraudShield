# STATE 3: USER_APPROVAL

**PRECONDITIONS:**
- STATE 2 POSTCONDITIONS met (plan presented to user)

**ACTIONS:**

Follow checkpoint-resumption protocol per `patterns/checkpoint-resumption.md`.

If K > 0, present the standard prompt:

> Plan ready. How would you like to proceed?
> 1. **approve** -- continue implementation now
> 2. **approve and clear** -- save plan, then clear context for a fresh start
> 3. Or tell me what to change

DO NOT proceed until the user explicitly replies with approval.

**Save the approved plan.** Write the plan to `.runs/current-plan.md` with YAML frontmatter:

```yaml
---
skill: harden
archetype: [from experiment.yaml type, default web-app]
branch: chore/harden-production
stack: { [category]: [value], ... }
checkpoint: step3-setup
modules:
  - name: [module-1-name]
    files: [source file paths]
    behaviors: [b-NN, b-NN]
  - name: [module-2-name]
    files: [source file paths]
    behaviors: [b-NN]
context_files:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - .claude/archetypes/[archetype].md
  - [each .claude/stacks/<category>/<value>.md read in Step 1]
---
```

Then append the plan body. The `modules` list preserves the dependency-ordered sequence so resume knows which modules are done and which are next.

If the user replied **"approve and clear"** or **"2"**:
  1. Save the plan with frontmatter (same as above)
  2. Tell the user: "Plan saved. Run `/clear`, then re-run `/harden` with the exact same command (including any arguments). Checkpoint resumption requires matching the original invocation."
  3. **STOP** -- do NOT proceed to STATE 4. This is a TERMINAL path.

If the user requests changes instead of approving, revise the plan to address their feedback and present it again (return to STATE 2). Repeat until approved.

**POSTCONDITIONS:**
- User has explicitly approved the plan (option 1 or 2)
- `.runs/current-plan.md` written with YAML frontmatter and plan body

**VERIFY:**
```bash
test -f .runs/current-plan.md && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 3
```

**NEXT:** If user chose "approve and clear": TERMINAL -- plan saved, user will `/clear` and re-run `/harden`. Otherwise, read [state-4-branch-and-config.md](state-4-branch-and-config.md) to continue.
