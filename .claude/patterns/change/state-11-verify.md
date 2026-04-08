# STATE 11: VERIFY

**PRECONDITIONS:**
- Implementation complete (STATE 10 POSTCONDITIONS met)
- Checkpoint is `phase2-step7`

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

- Follow the verification procedure in `.claude/patterns/verify.md` with **scope: [scope from Step 3]**:
  1. Build & lint loop (max 3 attempts)
  2. Save notable patterns (if you fixed errors)
  3. Template observation review (ALWAYS — even if no errors were fixed)
- **Note**: When scope is `full` or `security`, `/verify` automatically spawns spec-reviewer as an additional parallel agent. spec-reviewer validates all behaviors are implemented and unit tests are present. No extra action needed — just be aware it runs.
- **Write conflict prevention**: verify.md now requires edit-capable agents (design-critic, ux-journeyer) to run serially — not in parallel. The verification procedure handles this automatically. No extra action needed.
- Re-read `.runs/current-plan.md` to verify implementation matches the approved plan. Check that every item in the plan has been addressed.
- Type-specific checks:
  - **Feature**: trace the user flow — can a user discover, use, and complete the feature? Verify all new analytics events fire.
  - **Fix**: trace the bug report's user flow through code to confirm it's fixed.
  - **Polish**: open each changed file and confirm analytics imports and event calls are intact.
  - **Analytics**: re-trace each funnel event through the code to confirm it now fires correctly.
  - **Production quality**: verify.md spawns spec-reviewer in addition to scope-determined agents. Pass experiment.yaml + `.runs/current-plan.md` to spec-reviewer.
  - **Test**: verify test discovery works by running the testing stack file's test command in dry-run/list mode (e.g., `npx playwright test --list` for Playwright, `npx vitest run --reporter=verbose` for Vitest). If test discovery fails, treat it as a build error — fix the test files and re-run. If still failing after the verify.md retry budget, report to the user with the error output.
  - **Feature (spec compliance)**: Re-read `.runs/current-plan.md` and `experiment/experiment.yaml`. Verify implementation matches the archetype's primary units:
    - If archetype requires pages: confirm `src/app/<page-name>/page.tsx` exists for each unique page referenced in experiment.yaml `golden_path`
    - If archetype requires `endpoints`: confirm API route exists for each endpoint in experiment.yaml `endpoints` (path depends on framework stack file)
    - If archetype requires `commands` (cli): confirm `src/commands/<command-name>.ts` exists for each entry in the experiment.yaml command list
    - For each behavior in `behaviors`, confirm the implementation addresses it. For each event in `experiment/EVENTS.yaml`, confirm tracking calls are intact. If anything is missing, fix it before proceeding.
  - **Fix (skill deficiency attribution)**: After confirming the fix works (above), analyze which upstream skill should have prevented this bug:
    1. Read `.claude/patterns/skill-coverage-map.md`
    2. Classify the defect from the actual fix diff (`git diff --name-only $(git merge-base HEAD main)...HEAD`) and `.runs/fix-log.md` (if exists). Use verifier taxonomy codes (B1-B6, D1-D6, A1-A5, S1-S8). Priority: D/A > B > S. If ambiguous, use "unclassified"
    3. Look up the coverage map: which skill(s) + state(s) should prevent this defect category
    4. Check `.runs/verify-history.jsonl` for execution history — only attribute to skills that actually ran. If file doesn't exist, note "execution history unavailable"
    5. Write optional fields to `.runs/change-context.json`:
       - `defect_category`: string (e.g. "D3") or "unclassified"
       - `skill_deficiency`: array of `{"skill": "<name>", "state": "<N>", "reason": "<why>"}` or null if unclassified
       - `attribution_confidence`: "high" (category clear + skill ran), "medium" (category clear + no history), "low" (unclassified)
    Conservative attribution: only attribute to skills whose coverage map entry explicitly includes the defect category. When uncertain, set `skill_deficiency` to null.

Update checkpoint in `.runs/current-plan.md` frontmatter to `phase2-step8`.

**POSTCONDITIONS:**
- Verification procedure completed per scope
- Build passes
- Type-specific checks passed
- Implementation matches approved plan
- If type is Fix: `defect_category` field present in change-context.json (may be "unclassified")
- Checkpoint updated to `phase2-step8`

**VERIFY:**
```bash
head -1 .runs/verify-report.md | grep -q '^---$' && grep -q 'checkpoint: phase2-step8' .runs/current-plan.md
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 11
```

**NEXT:** Read [state-12-commit-and-pr.md](state-12-commit-and-pr.md) to continue.
