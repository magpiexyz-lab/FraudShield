# STATE 3: UPDATE_INVENTORY

**PRECONDITIONS:**
- Review-Fix Loop exited (via State 2b zero findings, State 2e no fixes, or State 2f termination)

**ACTIONS:**

If new validator checks were implemented in State 2e:

- Add each to the appropriate table in `scripts/check-inventory.md`
- Update the total counts in the header
- Clear any matching entries from the Pending table

**POSTCONDITIONS:**
- `scripts/check-inventory.md` updated with new checks (if any were added)
- Total counts in header are accurate
- No stale Pending entries for implemented checks

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/review-complete.json')); assert d.get('timestamp'), 'timestamp empty'; assert isinstance(d.get('iterations'), int) and d['iterations'] >= 1, 'iterations invalid'; assert isinstance(d.get('findings_fixed'), int) and d['findings_fixed']>=0, 'findings_fixed invalid'; assert isinstance(d.get('findings_disputed'), int) and d['findings_disputed']>=0, 'findings_disputed invalid'; assert isinstance(d.get('final_errors'), int) and d['final_errors']>=0, 'final_errors invalid'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh review 3
```

**NEXT:** Read [state-4-final-validation.md](state-4-final-validation.md) to continue.
