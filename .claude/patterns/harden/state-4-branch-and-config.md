# STATE 4: BRANCH_AND_CONFIG

**PRECONDITIONS:**
- STATE 3 POSTCONDITIONS met (user approved, plan saved)
- User chose option 1 ("approve"), not "approve and clear"

**ACTIONS:**

1. Branch setup (`chore/harden-production`) per `patterns/branch.md`
2. Set `quality: production` in experiment.yaml
3. Add `stack.testing` if absent (playwright for web-app, vitest for service/cli). Install testing packages per testing stack file.

Update checkpoint in `.runs/current-plan.md` frontmatter to `step3-module-1`.

> **Checkpoint update:** Edit only the `checkpoint:` line in the frontmatter -- single-line edit, not a full file rewrite.

**POSTCONDITIONS:**
- Current branch is `chore/harden-production` (or variant)
- `quality: production` is set in experiment.yaml
- `stack.testing` is present in experiment.yaml
- Testing packages installed
- Checkpoint updated to `step3-module-1`

**VERIFY:**
```bash
git branch --show-current | grep -q 'chore/harden' && grep -q 'quality.*production' experiment/experiment.yaml && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 4
```

**NEXT:** Read [state-5-module-loop.md](state-5-module-loop.md) to continue.
