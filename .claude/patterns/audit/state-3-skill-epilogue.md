# STATE 3: SKILL_EPILOGUE

**PRECONDITIONS:**
- Report and optional manifest output complete (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.claude/runs/audit-context.json`
- Expected completed states: `[0, 1, 2]` (from state-registry.json)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.claude/runs/observe-result.json` exists with `"skill": "audit"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.claude/runs/observe-result.json')); assert d['skill']=='audit'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh audit 3
```

**NEXT:** TERMINAL
