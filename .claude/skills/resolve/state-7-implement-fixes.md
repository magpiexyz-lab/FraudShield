# STATE 7: IMPLEMENT_FIXES

**PRECONDITIONS:**
- On `fix/resolve-*` branch (STATE 6 POSTCONDITIONS met)

**ACTIONS:**

For each issue in severity order (HIGH first):

1. Implement the fix per the approved fix plan from Step 5
1b. After each fix, log it in `.runs/fix-log.md` (create with header `# Error Fix Log` if absent):
    `**Fix N** — <file>: <one-line description of what was fixed and why>`
    This enables the skill epilogue's observation detection in Step 11.
2. If a validator check was proposed: implement it in the target script
2b. If the bug involves a configuration not covered by existing test
    fixtures (identified in Step 5b or by checking `tests/fixtures/`):
    create a minimal fixture following existing naming conventions.
    Include only the stack/archetype config needed to trigger the bug
    pattern, with assertions that catch it. Skip if triggering config
    is already covered.
3b. **Record fixture evaluation** in `resolve-context.json`:
    Set `fixtures_evaluated` to a list of fixture files checked from `tests/fixtures/`,
    or `["not_needed: <reason>"]` if no fixture is applicable for this fix.
    ```bash
    python3 -c "
    import json
    ctx = json.load(open('.runs/resolve-context.json'))
    ctx['fixtures_evaluated'] = []  # list of fixture files checked, or ['not_needed: <reason>']
    json.dump(ctx, open('.runs/resolve-context.json', 'w'), indent=2)
    "
    ```
3c. Run all 3 validators:
   - `python3 scripts/validate-frontmatter.py`
   - `python3 scripts/validate-semantics.py`
   - `bash scripts/consistency-check.sh`
4. If error count increased vs pre-fix count -> revert with
   `git checkout -- <modified files>`, log as "reverted", move to next issue
5. If error count same or decreased -> keep the fix

If new validator checks were added:
- Update `scripts/check-inventory.md` (add to appropriate table, update counts)

**POSTCONDITIONS:**
- All approved fixes implemented (or reverted with logged reason)
- Validator error count has not increased vs `pre_fix_baseline`
- `check-inventory.md` updated if new checks were added
- Git working tree has changes (fixes applied)

**VERIFY:**
```bash
(git diff --name-only HEAD 2>/dev/null | grep -q . || git diff --cached --name-only 2>/dev/null | grep -q .) && python3 -c "import json; ctx=json.load(open('.runs/resolve-context.json')); fe=ctx.get('fixtures_evaluated'); assert fe is not None, 'fixtures_evaluated missing from resolve-context.json'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 7
```

**NEXT:** Read [state-8-final-validation.md](state-8-final-validation.md) to continue.
