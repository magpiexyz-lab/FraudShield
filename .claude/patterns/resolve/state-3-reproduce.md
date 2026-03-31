# STATE 3: REPRODUCE

**PRECONDITIONS:**
- User approved triage (STATE 2 POSTCONDITIONS met)
- At least one actionable issue remains

**ACTIONS:**

For each actionable issue (after user approval of triage):

Reproduce the issue by tracing through the template as if you were Claude
executing the skill:

1. Read the skill/pattern file cited in the issue
2. Walk through each step, evaluating conditionals against the configuration
   that triggers the bug
3. Identify the exact step and line where behavior diverges from expectation
4. Record: `divergence_point` (file:line), `expected` behavior, `actual` behavior
5. **Validator evidence** (machine-verifiable baseline):
   Run all 3 validators and capture output as `pre_fix_baseline`:
   - `python3 scripts/validate-frontmatter.py 2>&1`
   - `python3 scripts/validate-semantics.py 2>&1`
   - `bash scripts/consistency-check.sh 2>&1`

   Search validator output for errors citing the issue's file(s).
   If a validator error corresponds to the divergence_point:
   `reproduction = "validator-confirmed"` + the error line(s).
   Otherwise: `reproduction = "simulation-only"` (acceptable for
   prose/logic bugs that validators cannot catch).

**Cannot reproduce:** If the simulation completes without finding a divergence
point, the issue may have been fixed indirectly (e.g., by a refactor or a
related fix that also covered this case). Downgrade the issue to non-actionable:
comment with "Unable to reproduce against current main — the described behavior
no longer occurs. [explain what was checked]. Reopen if the issue persists."
Close the issue and remove it from the actionable list. Continue with remaining
issues.

- **Write reproduction artifact** (`.claude/runs/resolve-reproduction.json`):
  ```bash
  python3 -c "
  import json
  repro = {
      'reproductions': [
          {'issue': 0, 'divergence_point': '<file:line>', 'expected': '<...>', 'actual': '<...>', 'reproduced': True}
      ],
      'pre_fix_baseline': {'frontmatter': 0, 'semantics': 0, 'consistency': 0}
  }
  json.dump(repro, open('.claude/runs/resolve-reproduction.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Each actionable issue has: `divergence_point`, `expected`, `actual`, `reproduction`
- `pre_fix_baseline` captured from all 3 validators
- Issues that cannot be reproduced are closed and removed from actionable list
- `.claude/runs/resolve-reproduction.json` exists

**VERIFY:**
```bash
test -f .claude/runs/resolve-reproduction.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 3
```

**NEXT:** Read [state-4-blast-radius.md](state-4-blast-radius.md) to continue.
