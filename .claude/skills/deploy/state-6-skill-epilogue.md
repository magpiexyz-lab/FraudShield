# STATE 6: SKILL_EPILOGUE

**PRECONDITIONS:**
- Deploy manifest written and Q-score computed (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

### Cleanup stale artifacts

```bash
rm -f .runs/observe-result.json .runs/epilogue-context.json .runs/observer-diffs.txt
```

Follow `.claude/patterns/skill-epilogue.md` **Strategy A** (Code Observation)
to evaluate whether any deploy fixes trace to template-rooted issues.

Since `/deploy` does not create a git branch with code changes, the observer's
diff input is limited to auto-fix iterations from STATE 4 (health check retries,
provision fixes).

**If no auto-fix rounds occurred** (no retries, health check passed first attempt):
- Write observe-result.json with `"verdict": "clean"` — zero overhead

**If auto-fixes occurred:**
- Collect fix descriptions from the deploy session
- Evaluate against observe.md Path 2 criteria inline (deploy has no branch
  diff to send to observer agent)
- Write observe-result.json accordingly

```json
{
  "skill": "deploy",
  "timestamp": "<ISO 8601>",
  "strategy": "code-observation",
  "friction_detected": false,
  "observations_filed": 0,
  "verdict": "clean"
}
```

**POSTCONDITIONS:**
- `.runs/observe-result.json` exists with `"skill": "deploy"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='deploy'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh deploy 6
```

**NEXT:** TERMINAL
