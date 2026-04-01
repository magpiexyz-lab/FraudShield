# STATE 11: SKILL_EPILOGUE

**PRECONDITIONS:**
- Patterns saved (STATE 10 POSTCONDITIONS met)

**ACTIONS:**

### Q-score

Compute resolve execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/resolve-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 .claude/scripts/write-q-score.py \
  --skill resolve --scope resolve --archetype N/A \
  --gate 1.0 --dims "{\"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

Follow `.claude/patterns/skill-epilogue.md` to evaluate template observation.
This runs the observer agent if fixes were logged in `.runs/fix-log.md`,
or records "clean" if not. The epilogue must complete before the final commit
(`observe-commit-gate.sh` enforces this).

**POSTCONDITIONS:**
- Skill epilogue complete
- Observer agent run (if fixes were logged) or "clean" recorded

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='resolve'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 11
```

**NEXT:** This is the TERMINAL state. The /resolve skill is complete.
