# STATE 16: UNIT_TEST_GENERATION

**PRECONDITIONS:**
- STATE 15 POSTCONDITIONS met (scan complete, classification done)

**ACTIONS:**

Generate unit tests for CRITICAL modules using implementer agents.

**Module dependency analysis** (per `patterns/tdd.md` Task Dependency Ordering):
- For each CRITICAL module from `.runs/bootstrap-scan.json`, identify imports from other CRITICAL modules
- Order modules so dependencies are tested first (if A imports B, test B first)
- Independent modules can be in any order — place them first

For each CRITICAL module **in dependency order, sequentially**:
  a. Spawn implementer agent (`agents/implementer.md`, isolation: "worktree")
  b. Pass to implementer: file paths, the module's behaviors from experiment.yaml (behavior IDs and `tests` entries), and the classification reason
  c. Implementer writes unit tests per `patterns/tdd.md`:
     - What SHOULD the module do? (from behaviors + code reading)
     - Write tests for correct behavior
     - If test fails AND failure shows incorrect behavior → fix the code (bug discovery)
     - If test passes → specification captured
  d. **Merge worktree changes with verification:**
     - Verify implementer committed: `git log --oneline main..<worktree-branch>`
     - If no commit: re-spawn agent for commit-only (do NOT commit on behalf of the agent). Budget: 1 retry.
     - Merge: `git merge <worktree-branch> --no-ff -m "Merge unit tests: <module-name>"`
     - Verify merge: `git log --oneline -1` must show merge commit
  e. Run `npm run build` — if broken, fix before next module
  f. Log: "Module [name]: N tests added, all passing"

- **Write modules trace artifact** (`.runs/bootstrap-modules-trace.json`):
  ```bash
  python3 -c "
  import json
  trace = {
      'modules_completed': [
          {'name': '<module>', 'tests_added': 0, 'status': 'pass'}
      ],
      'build_passing': True
  }
  json.dump(trace, open('.runs/bootstrap-modules-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- All CRITICAL modules have unit tests
- All tests pass
- `npm run build` passes
- `.runs/bootstrap-modules-trace.json` exists

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/bootstrap-modules-trace.json')); s=json.load(open('.runs/bootstrap-scan.json')); c=s.get('critical',[]); m=d.get('modules_completed',[]); assert len(m)==len(c), 'count: %d completed vs %d critical'%(len(m),len(c)); assert set(x['name'] for x in m)==set(x['module'] for x in c), 'module name mismatch'; assert all(x.get('tests_added',0)>=1 for x in m), 'module with 0 tests_added'; assert d.get('build_passing') is True, 'build not passing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 16
```

**NEXT:** Read [state-17-persist-on-touch.md](state-17-persist-on-touch.md) to continue.
