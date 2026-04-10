# STATE 10: SKILL_EPILOGUE

**PRECONDITIONS:**
- External stack graduation evaluated (STATE 9a POSTCONDITIONS met)

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

### Worktree Cleanup (Ring 3 early exit only)

If you entered a worktree in STATE 0 AND the skill is terminating after this
state (Ring 3 — no code changes, no branch, no PR):

1. Copy Q-score back to main checkout:
```bash
MAIN_DIR=$(git worktree list | head -1 | awk '{print $1}')
mkdir -p "$MAIN_DIR/.runs"
tail -1 .runs/verify-history.jsonl >> "$MAIN_DIR/.runs/verify-history.jsonl" 2>/dev/null || true
```

2. Call the `ExitWorktree` tool with `action: "remove"` and `discard_changes: true` to return to the main checkout and delete the worktree.

If proceeding to STATE 11: skip this section (cleanup happens in STATE 11).

**POSTCONDITIONS:**
- Skill epilogue complete
- Observer agent run (if fixes were logged) or "clean" recorded

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='resolve'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 10
```

**NEXT:** Read [state-11-commit-pr.md](state-11-commit-pr.md) to continue.
