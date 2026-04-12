# STATE 4: SKILL_EPILOGUE

**PRECONDITIONS:**
- Retro issue filed (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/retro-context.json`
- Expected completed states: `[0, 1, 2, 3]` (from state-registry.json)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.runs/observe-result.json` exists with `"skill": "retro"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='retro'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh retro 4
```

**NEXT:** TERMINAL -- retro complete.
