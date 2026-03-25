# STATE 2: OUTPUT

**PRECONDITIONS:**
- Solve reasoning execution complete (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

Present the output exactly as specified in solve-reasoning.md Phase 6 (full mode) or Step 5 (light mode).

### Q-score

Compute solve quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.claude/solve-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 .claude/scripts/write-q-score.py \
  --skill solve --scope solve --archetype N/A \
  --gate 1.0 --dims '{"depth": 1.0, "output": 1.0}' \
  --run-id "$RUN_ID" || true
```

**STOP.** After presenting the output, end your response here. Do not implement anything.

The user decides next steps:
- Implement manually
- Run `/change` with the recommendation
- Ask follow-up questions
- Reject and re-run with different constraints

**POSTCONDITIONS:**
- Solution output presented to user
- No code changes made

**VERIFY:**
```bash
echo "Solution presented, awaiting user decision"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 2
```

**NEXT:** Read [state-3-skill-epilogue.md](state-3-skill-epilogue.md) to continue.
