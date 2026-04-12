# STATE x5: SKILL_EPILOGUE

**PRECONDITIONS:**
- Ranking and recommendations delivered (STATE x4 POSTCONDITIONS met)

**ACTIONS:**

### Strategy B Skill Epilogue

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/iterate-cross-context.json`
- Expected completed states: `["x0", "x1", "x2", "x3", "x4"]` (from skill.yaml states)
- This skill is analysis-only and makes no code changes (Chrome MCP actions on Google Ads UI are not code changes; PostHog API calls are read-only queries)

**Important:** When writing `observe-result.json`, use `"skill": "iterate-cross"` (not `"iterate"` or `"iterate-check"`).

**POSTCONDITIONS:**
- Strategy B epilogue completed
- `.runs/observe-result.json` exists with `"skill": "iterate-cross"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='iterate-cross'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x5
```

**NEXT:** TERMINAL -- cross-MVP evaluation complete.
