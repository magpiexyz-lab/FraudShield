# STATE 10: SAVE_PATTERNS

**PRECONDITIONS:**
- PR opened (STATE 9 POSTCONDITIONS met)

**ACTIONS:**

For each resolved issue, evaluate:

1. **Resolution pattern** (accelerates future diagnosis):
   Save to auto memory under "Resolution Patterns" heading:
   - Issue type + root cause pattern (1 line)
   - What to check first when this pattern recurs (1 line)
   - Example: "Missing archetype guard -> grep for archetype-conditional
     language in cited file, check all 3 archetypes have branches"

2. **Universal template pitfall** (prevents recurrence across projects):
   Note in auto memory: "Consider adding Known Pitfall to <file>."
   Do NOT edit stack/pattern files inline — that's scope creep.

Skip if: trivial fix (typo) unlikely to recur.

- **Write patterns-saved artifact** (`.claude/runs/patterns-saved.json`):
  ```bash
  python3 -c "
  import json
  saved = {
      'patterns_saved': [],  # list of pattern descriptions saved to memory
      'skipped_reason': ''   # if skipped: rationale
  }
  json.dump(saved, open('.claude/runs/patterns-saved.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Resolution patterns saved to auto memory (or skipped with rationale)
- `.claude/runs/patterns-saved.json` exists

**VERIFY:**
```bash
test -f .claude/runs/patterns-saved.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 10
```

**NEXT:** Read [state-11-skill-epilogue.md](state-11-skill-epilogue.md) to continue.
