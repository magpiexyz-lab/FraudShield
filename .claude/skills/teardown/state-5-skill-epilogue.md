# STATE 5: SKILL_EPILOGUE

**PRECONDITIONS:**
- Cleanup complete (STATE 4 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/teardown-context.json`
- Expected completed states: `[0, 1, 2, 3, 4]` (from state-registry.json)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.runs/observe-result.json` exists with `"skill": "teardown"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='teardown'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh teardown 5
```

**NEXT:** TERMINAL
