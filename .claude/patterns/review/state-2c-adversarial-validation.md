# STATE 2c: ADVERSARIAL_VALIDATION

**PRECONDITIONS:**
- Filtered findings available (STATE 2b POSTCONDITIONS met, with > 0 remaining findings)

**ACTIONS:**

Launch a single serial Explore subagent ("Adversarial Agent D") to challenge
each filtered finding before committing to fixes. Include in the agent prompt:

- All filtered findings from state 2b (full Finding Format)
- The `observation_backlog` from State 0 (if non-empty)
- Instructions — **Counterexample Construction**:

  For each finding, attempt to **construct a proof that the finding is false**.
  The default label is "confirmed" — you must produce positive evidence to dispute.

  **Dimension A (cross-file) findings:**
  1. Read both cited files
  2. Quote the exact lines alleged to contradict (with line numbers)
  3. Check: do these lines apply in the same context? (e.g., one may be inside
     a conditional that excludes the other's scenario)
  4. If no real contradiction when context is considered -> "disputed"

  **Dimension B (edge case) findings:**
  1. Identify which fixture(s) match the claimed configuration (use fixture names
     from the dimension agent's report)
  2. Read the fixture's `assertions` section — does it expect this behavior?
  3. Read the specific conditional branch in the cited skill/stack file
  4. If the conditional already handles the case -> "disputed", quoting the code
  5. If no fixture covers this config -> note "no fixture coverage" (stays "confirmed")

  **Dimension C (user journey) findings:**
  1. Trace the specific journey step claimed to be a dead-end
  2. Read the skill file at the cited step
  3. Check: is there a recovery path, error message, or next-step instruction
     the dimension agent missed?
  4. If a recovery path exists -> "disputed", quoting the path

  **Auto-confirm rule** (unchanged): finding matching an open observation's
  root cause -> "confirmed" without counterexample construction.

Output format — one entry per finding:
```
### Finding N: <title>
- **Label**: confirmed | disputed | needs-evidence
- **Counterexample**: <what you tried to prove and whether it succeeded>
- **Evidence**: <exact quotes with file:line references>
- **Observation match**: #<number> | none
```

After the agent returns, partition findings:
- **confirmed**: full priority in fix phase
- **needs-evidence**: lower priority (sorted after confirmed in fix queue)
- **disputed**: removed from fix queue; record finding signature + one-line rationale for the PR body
- If 0 findings remain after removing disputed -> continue to 2d (the existing 2b exit handles the zero-findings case)

- **Write adversarial artifact** (`.runs/review-adversarial.json`):
  ```bash
  python3 -c "
  import json
  adversarial = {
      'confirmed': [],    # list of finding titles
      'disputed': [],     # list of {title, rationale}
      'needs_evidence': []
  }
  json.dump(adversarial, open('.runs/review-adversarial.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Each finding labeled: confirmed, disputed, or needs-evidence
- Fix queue ordered: confirmed (by severity), then needs-evidence (by severity)
- Disputed findings recorded with rationale
- `.runs/review-adversarial.json` exists

**VERIFY:**
```bash
test -f .runs/review-adversarial.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh review 2c
```

**NEXT:** Read [state-2d-branch-setup.md](state-2d-branch-setup.md) to continue.
