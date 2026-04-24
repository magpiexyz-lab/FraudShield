# STATE 7: IMPLEMENT_FIXES

**PRECONDITIONS:**
- On `fix/resolve-*` branch (STATE 6 POSTCONDITIONS met)

**ACTIONS:**

For each issue in severity order (HIGH first):

0. **Present fix summary and wait for approval:**
   Before implementing, present a brief explanation to the user:
   ```
   **Fix for #<N>: <title>**
   - Root cause: <1 sentence>
   - What changes: <files and what's modified, 1-2 bullets>
   - Risk: <low/medium — blast radius summary>
   ```
   **Learned pattern basis (advisory — only when `pattern_hints` non-empty):**
   If `.runs/resolve-triage.json.pattern_hints` has entries matching this issue,
   append a short block listing each hint's `id`, `maturity`, `confidence_score`,
   and a one-line pointer to `fix_template`. Example:
   ```
   #### Learned pattern basis
   - nextjs-demo-guard (canonical, confidence 1.0) — fix_template: add VERCEL guard before DEMO_MODE check
   ```
   This is purely informational — it does NOT change the approval flow below.
   **STOP. Wait for the user to approve this fix before implementing.**
   If the user rejects a fix, log it in `.runs/fix-log.md` as
   `**Rejected** — #<N>: <title> — rejected by user` and move to the next issue.

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

**After all fixes have been processed:**
- Record rejected issue numbers in `resolve-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.runs/resolve-context.json'))
  ctx['rejected_issues'] = []  # list of issue numbers rejected by user (empty if none)
  json.dump(ctx, open('.runs/resolve-context.json', 'w'), indent=2)
  "
  ```
- If ALL fixes were rejected (no changes in git working tree):
  1. Report: "All fixes were rejected — no changes to commit. Issues remain open."
  2. Write the no-fixes marker to resolve-context.json so VERIFY recognises the
     legitimate early-exit path (registry declares
     `allows_early_exit_when: "all_fixes_rejected"`):
     ```bash
     python3 -c "
     import json
     ctx = json.load(open('.runs/resolve-context.json'))
     ctx['all_fixes_rejected'] = True
     if ctx.get('fixtures_evaluated') is None:
         ctx['fixtures_evaluated'] = ['not_needed: all_fixes_rejected']
     json.dump(ctx, open('.runs/resolve-context.json', 'w'), indent=2)
     "
     ```
  3. Advance state and **TERMINAL** — skill ends, no PR created.

**POSTCONDITIONS:**
- All approved fixes implemented (or reverted with logged reason)
- Validator error count has not increased vs `pre_fix_baseline`
- `check-inventory.md` updated if new checks were added
- `rejected_issues` recorded in `resolve-context.json`
- Git working tree has changes (fixes applied) — unless all-rejected TERMINAL

**VERIFY:**
```bash
python3 -c "import json,subprocess; ctx=json.load(open('.runs/resolve-context.json')); has_diff=bool(subprocess.run(['git','diff','--name-only','HEAD'],capture_output=True,text=True).stdout.strip() or subprocess.run(['git','diff','--cached','--name-only'],capture_output=True,text=True).stdout.strip()); all_rejected=ctx.get('all_fixes_rejected') is True; assert has_diff or all_rejected, 'no diff and no all_fixes_rejected marker in resolve-context.json'; fe=ctx.get('fixtures_evaluated'); assert fe is not None, 'fixtures_evaluated missing from resolve-context.json'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 7
```

**NEXT:** Read [state-8-final-validation.md](state-8-final-validation.md) to continue.
