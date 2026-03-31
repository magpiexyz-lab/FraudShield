# STATE 6: SKILL_EPILOGUE

**PRECONDITIONS:**
- PR created or clean review reported (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

### Cleanup stale artifacts

```bash
rm -f .claude/runs/observe-result.json .claude/runs/epilogue-context.json .claude/runs/observer-diffs.txt
```

Follow `.claude/patterns/skill-epilogue.md` **Strategy A** (Code Observation)
to evaluate whether any review fixes trace to template-rooted issues.

If no branch exists (clean review with no findings that needed fixing),
write observe-result.json with `"verdict": "clean"` and skip observer spawn:

```json
{
  "skill": "review",
  "timestamp": "<ISO 8601>",
  "strategy": "code-observation",
  "friction_detected": false,
  "observations_filed": 0,
  "verdict": "clean"
}
```

If a branch exists with diffs, proceed through skill-epilogue.md Steps 1-4
to collect evidence, write epilogue context, and spawn the observer agent.

**POSTCONDITIONS:**
- `.claude/runs/observe-result.json` exists with `"skill": "review"`
- Observer agent run (if branch had diffs) or "clean" recorded

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.claude/runs/observe-result.json')); assert d['skill']=='review'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh review 6
```

**NEXT:** TERMINAL — review complete.
