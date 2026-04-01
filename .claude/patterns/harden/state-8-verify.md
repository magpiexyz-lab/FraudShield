# STATE 8: VERIFY

**PRECONDITIONS:**
- STATE 7 POSTCONDITIONS met (ON-TOUCH list persisted)

**ACTIONS:**

Run full verification: `/verify` with **scope: full** (the default scope). This spawns all agents including spec-reviewer (conditional on `quality: production`, which STATE 4 just set).

Update checkpoint to `step3-pr`.

**POSTCONDITIONS:**
- `/verify` completed successfully
- `.runs/verify-report.md` exists
- Checkpoint updated to `step3-pr`

**VERIFY:**
```bash
test -f .runs/verify-report.md && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 8
```

**NEXT:** Read [state-9-commit-and-pr.md](state-9-commit-and-pr.md) to continue.
