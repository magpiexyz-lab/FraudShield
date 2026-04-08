# STATE 8: FINAL_VALIDATION

**PRECONDITIONS:**
- Fixes implemented (STATE 7 POSTCONDITIONS met)

**ACTIONS:**

- Run all 3 validators
- Record `final_errors`
- If `final_errors` > 0 for checks that passed before Step 7: stop and report regression

- **Write validation artifact** (`.runs/resolve-validation.json`):
  ```bash
  python3 -c "
  import json
  validation = {
      'frontmatter_errors': 0,
      'semantics_errors': 0,
      'consistency_errors': 0,
      'regressions': False
  }
  json.dump(validation, open('.runs/resolve-validation.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- All 3 validators run
- `final_errors` recorded
- No regressions (no new failures for checks that passed before Step 7)
- `.runs/resolve-validation.json` exists

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/resolve-validation.json')); assert 'regressions' in d, 'regressions field missing'; assert d['regressions']==False, 'regressions detected'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 8
```

**NEXT:** Read [state-8b-side-effect-scan.md](state-8b-side-effect-scan.md) to continue.
