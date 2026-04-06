# STATE x5: SKILL_EPILOGUE

**PRECONDITIONS:**
- Ranking and recommendations complete (STATE x4 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/iterate-cross-context.json`
- Expected completed states: `["x0", "x1", "x2", "x3", "x4"]` (from state-registry.json agent_gates)
- This skill is analysis-only and makes no code changes (Chrome MCP reads and PostHog API queries are not code changes)

**Important:** When writing `observe-result.json`, use `"skill": "iterate-cross"` (not `"iterate"`).

**POSTCONDITIONS:**
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
