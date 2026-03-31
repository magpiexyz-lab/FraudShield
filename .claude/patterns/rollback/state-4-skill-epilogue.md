# STATE 4: SKILL_EPILOGUE

**PRECONDITIONS:**
- Rollback executed and health check complete (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.claude/runs/rollback-context.json`
- Expected completed states: `[0, 1, 2, 3]` (from state-registry.json)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.claude/runs/observe-result.json` exists with `"skill": "rollback"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.claude/runs/observe-result.json')); assert d['skill']=='rollback'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh rollback 4
```

**NEXT:** TERMINAL -- rollback complete.
