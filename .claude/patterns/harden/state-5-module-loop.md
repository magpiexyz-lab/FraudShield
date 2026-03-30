# STATE 5: MODULE_LOOP

**PRECONDITIONS:**
- STATE 4 POSTCONDITIONS met (branch created, config set, testing installed)
- `.claude/current-plan.md` exists with approved module list

**ACTIONS:**

**Module dependency analysis** (per `patterns/tdd.md` Task Dependency Ordering):
- For each approved CRITICAL module, identify imports from other CRITICAL modules
- Order modules so dependencies are hardened first (if A imports B, harden B first)
- Independent modules can be in any order -- place them first
- The plan's Dependency Order section (STATE 2) already shows this -- use that order

For each approved CRITICAL module **in dependency order, sequentially**:
  a. Spawn implementer agent (`agents/implementer.md`, isolation: "worktree")
  b. Pass to implementer: file paths, the "Specifications to test" list from the approved plan, and mapped experiment.yaml behavior IDs (b-NN)
  c. Implementer writes specification tests per `patterns/tdd.md`:
     - What SHOULD the module do? (from the plan's specifications list + code reading)
     - Write tests for correct behavior
     - If test fails AND failure shows incorrect behavior -> fix the code (bug discovery protocol)
     - If test passes -> specification captured
  d. **Merge worktree changes with verification:**
     - Verify implementer committed: `git log --oneline main..<worktree-branch>`
     - If no commit: re-spawn agent for commit-only (do NOT commit on behalf of the agent). Budget: 1 retry.
     - Merge: `git merge <worktree-branch> --no-ff -m "Merge implementer: <module-name>"`
     - Verify merge: `git log --oneline -1` must show merge commit
  e. Run `npm run build` -- if broken, fix before next module
  f. Log: "Module [name]: N tests added, all passing"
  g. Update checkpoint in `.claude/current-plan.md` frontmatter to `step3-module-[next]` (where [next] is the 1-indexed number of the next module to process)

- **Write modules trace artifact** (`.claude/harden-modules-trace.json`):
  ```bash
  python3 -c "
  import json
  trace = {
      'modules_completed': [
          {'name': '<module>', 'tests_added': 0, 'status': 'pass'}
      ],
      'build_passing': True
  }
  json.dump(trace, open('.claude/harden-modules-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- All approved CRITICAL modules have specification tests
- All tests pass
- `npm run build` passes
- Checkpoint updated for each completed module
- `.claude/harden-modules-trace.json` exists

**VERIFY:**
```bash
test -f .claude/harden-modules-trace.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 5
```

**NEXT:** Read [state-6-reconcile.md](state-6-reconcile.md) to continue.
