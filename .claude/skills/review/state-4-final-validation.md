# STATE 4: FINAL_VALIDATION

**PRECONDITIONS:**
- Inventory updated (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

- Run all 3 validators
- Record `final_errors`
- If `final_errors` > `baseline_errors` -> stop and report regression
- Write `.runs/review-complete.json` (required by verify-pr-gate.sh for PR creation):
  ```bash
  cat > .runs/review-complete.json << RCEOF
  {
    "branch": "$(git branch --show-current)",
    "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "iterations": <iteration count>,
    "yield": <overall yield rate>,
    "baseline_errors": <baseline_errors>,
    "final_errors": <final_errors>,
    "findings_fixed": <total fixed across all iterations>,
    "findings_disputed": <total disputed across all iterations>
  }
  RCEOF
  ```

**POSTCONDITIONS:**
- All 3 validators ran
- `final_errors` <= `baseline_errors` (no regression)
- `.runs/review-complete.json` written

**VERIFY:**
```bash
test -f .runs/review-complete.json && python3 scripts/validate-frontmatter.py > /dev/null 2>&1 && python3 scripts/validate-semantics.py > /dev/null 2>&1 && bash scripts/consistency-check.sh > /dev/null 2>&1
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh review 4
```

**NEXT:** Read [state-6-commit-pr.md](state-6-commit-pr.md) to continue.
