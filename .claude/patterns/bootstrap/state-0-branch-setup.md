# STATE 0: BRANCH_SETUP

**PRECONDITIONS:**
- Git repository exists in working directory
- Current branch is `main` (or resuming on existing `feat/bootstrap*` branch)

**ACTIONS:**

Follow the branch setup procedure in `.claude/patterns/branch.md`. Use branch prefix `feat` and branch name `feat/bootstrap`.

Clean up stale artifacts from prior runs:
- `rm -rf .runs/gate-verdicts/ externals-decisions.json`

> **If resuming from a failed bootstrap:** see `.claude/patterns/recovery.md` for recovery options.

Create `.runs/bootstrap-context.json` to initialize state tracking:
```bash
cat > .runs/bootstrap-context.json << CTXEOF
{"skill":"bootstrap","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"bootstrap-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0]}
CTXEOF
```

**POSTCONDITIONS:**
- Current branch is `feat/bootstrap` (or `feat/bootstrap-N` if prior branch exists)
- Branch is not `main`
- `.runs/bootstrap-context.json` exists

**VERIFY:**
```bash
git branch --show-current | grep -q 'feat/bootstrap' && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 0
```

**NEXT:** Read [state-1-read-context.md](state-1-read-context.md) to continue.
