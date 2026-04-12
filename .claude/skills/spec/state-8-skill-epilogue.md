# STATE 8: SKILL_EPILOGUE

**PRECONDITIONS:**
- Output written and validated (STATE 7 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy A** (Code Observation)
to ensure observation result is recorded.

**If STATE 7 step 7c.2 already wrote `.runs/observe-result.json`** (validation
required fixes that triggered inline observation):
- Verify the file exists and contains `"skill": "spec"` — no additional work needed

**If no observe-result.json exists** (validation passed first attempt, or step 7c.2
was skipped):
- Write observe-result.json with `"verdict": "clean"`

```json
{
  "skill": "spec",
  "timestamp": "<ISO 8601>",
  "strategy": "code-observation",
  "friction_detected": false,
  "observations_filed": 0,
  "verdict": "clean"
}
```

This state ensures observe-result.json always exists after `/spec`, regardless
of whether inline observation fired in STATE 7.

**POSTCONDITIONS:**
- `.runs/observe-result.json` exists with `"skill": "spec"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='spec'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh spec 8
```

**NEXT:** TERMINAL
