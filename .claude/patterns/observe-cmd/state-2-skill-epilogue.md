# STATE 2: SKILL_EPILOGUE

**PRECONDITIONS:**
- Evaluation and filing complete (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/observe-context.json`
- Expected completed states: `[0, 1]` (from state-registry.json, excluding this epilogue state)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.runs/observe-result.json` exists with `"skill": "observe"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='observe'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh observe 2
```

**NEXT:** TERMINAL -- observation complete.
