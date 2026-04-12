# STATE 2e: FIX_FINDINGS

**PRECONDITIONS:**
- On `chore/review-fixes*` branch (STATE 2d POSTCONDITIONS met)
- Fix queue ordered from adversarial validation

**ACTIONS:**

For each finding in priority order: HIGH-severity confirmed, then MEDIUM confirmed, then LOW confirmed, then needs-evidence (by severity descending):

1. Implement the fix
2. If finding has a Proposed Check -> implement it in the target validator
3. Run all 4 validators (3 scripts + shellcheck on hooks)
4. If error count increased vs pre-fix count -> revert with
   `git checkout -- <modified files>`, log as "reverted", move to next
5. If error count same or decreased -> keep the fix
   (do NOT commit per-fix; accumulate changes for a single commit)
6. Record the finding's fate: `fixed`, `reverted`, or `skipped` (if not attempted).
   Carry fates forward in the compact state.

The 4 validators (3 scripts + shellcheck) serve as this skill's quality gate,
analogous to the build verification in `.claude/patterns/verify.md`.

If no fixes succeeded this iteration -> **exit loop**, proceed to State 3.

**POSTCONDITIONS:**
- Each finding in the fix queue has a fate: `fixed`, `reverted`, or `skipped`
- All kept fixes pass validators (error count same or decreased)
- If any confirmed finding included a Proposed Check, verify via `git diff --name-only` that the target validator file(s) have been modified. A Proposed Check may require changes across multiple validators (validate-frontmatter.py, validate-semantics.py, consistency-check.sh) — verify all cited targets. If a proposed check was not implemented, return to the finding and implement it before proceeding.
- Changes accumulated (not committed yet)

**VERIFY:**
```bash
git diff --name-only HEAD 2>/dev/null | grep -q . || git diff --cached --name-only 2>/dev/null | grep -q .
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh review 2e
```

**NEXT:** Read [state-2f-loop-gate.md](state-2f-loop-gate.md) to continue.
