# STATE 3: SKILL_EPILOGUE

**PRECONDITIONS:**
- Solution output presented (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/solve-context.json`
- Expected completed states: `[0, 1, 2]` (from state-registry.json)
- This skill is analysis-only and makes no code changes

**POSTCONDITIONS:**
- `.runs/observe-result.json` exists with `"skill": "solve"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='solve'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 3
```

### Worktree Cleanup

If you entered a worktree in STATE 0:

1. Copy Q-score back to main checkout:
```bash
MAIN_DIR=$(git worktree list | head -1 | awk '{print $1}')
mkdir -p "$MAIN_DIR/.runs"
tail -1 .runs/verify-history.jsonl >> "$MAIN_DIR/.runs/verify-history.jsonl" 2>/dev/null || true
```

2. Call the `ExitWorktree` tool with `action: "remove"` to return to the main checkout and delete the worktree.

If you did NOT enter a worktree (EnterWorktree failed in STATE 0): skip this section.

**NEXT:** TERMINAL -- user decides next action.
