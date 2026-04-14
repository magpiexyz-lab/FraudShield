# STATE 19: VERIFY

**PRECONDITIONS:**
- STATE 18 POSTCONDITIONS met (all files staged, BG4 PASS, commit-message.txt written)
- Checkpoint is `awaiting-verify`

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

- Follow the verification procedure in `.claude/patterns/verify.md` with **scope: full**:
  1. Build & lint loop (max 3 attempts)
  2. Save notable patterns (if you fixed errors)
  3. Template observation review (ALWAYS — even if no errors were fixed)
- **Note**: scope `full` automatically spawns spec-reviewer as an additional parallel agent. spec-reviewer validates all behaviors are implemented and unit tests are present. No extra action needed — just be aware it runs.
- **Write conflict prevention**: verify.md requires edit-capable agents (design-critic, ux-journeyer) to run serially — not in parallel. The verification procedure handles this automatically. No extra action needed.
- Re-read `.runs/current-plan.md` to verify implementation matches the approved plan. Check that every item in the plan has been addressed.

**POSTCONDITIONS:**
- Verification procedure completed with scope: full
- Build passes
- verify-report.md exists with valid frontmatter
- Implementation matches approved plan
- PR delivery artifacts written by verify/state-8 bootstrap-verify mode (pr-title.txt, pr-body.md)

**VERIFY:**
```bash
head -1 .runs/verify-report.md | grep -q '^---$'
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 19
```

**NEXT:** TERMINAL — `lifecycle-finalize.sh` handles commit, push, PR creation, and auto-merge.
