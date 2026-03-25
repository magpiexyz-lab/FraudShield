# STATE 3: SKILL_EPILOGUE

**PRECONDITIONS:**
- Solution output presented (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.claude/solve-context.json`
- Expected completed states: `[0, 1, 2]` (from state-registry.json)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.claude/observe-result.json` exists with `"skill": "solve"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.claude/observe-result.json')); assert d['skill']=='solve'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 3
```

**NEXT:** TERMINAL -- user decides next action.
