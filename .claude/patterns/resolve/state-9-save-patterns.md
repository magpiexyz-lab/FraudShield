# STATE 9: SAVE_PATTERNS

**PRECONDITIONS:**
- Side-effect scan complete (STATE 8b POSTCONDITIONS met)

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

- **Write patterns-saved artifact** (`.runs/patterns-saved.json`):
  ```bash
  python3 -c "
  import json
  saved = {
      'patterns_saved': [],  # list of pattern descriptions saved to memory
      'skipped_reason': ''   # if skipped: rationale
  }
  json.dump(saved, open('.runs/patterns-saved.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Resolution patterns saved to auto memory (or skipped with rationale)
- `.runs/patterns-saved.json` exists

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/patterns-saved.json')); assert isinstance(d.get('patterns_saved'), list), 'patterns_saved not a list'; assert 'skipped_reason' in d, 'skipped_reason missing'; assert len(d['patterns_saved'])>0 or d['skipped_reason'], 'no patterns saved and no skip reason'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 9
```

**NEXT:** Read [state-9a-graduate-external.md](state-9a-graduate-external.md) to continue.
