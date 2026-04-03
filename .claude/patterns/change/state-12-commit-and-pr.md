# STATE 12: COMMIT_AND_PR

**PRECONDITIONS:**
- Verification complete (STATE 11 POSTCONDITIONS met)
- Checkpoint is `phase2-step8`
- `.runs/verify-report.md` exists

**ACTIONS:**

Follow gate execution procedure per `procedures/gate-execution.md`.

- **G5 Verification Gate**: Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute G5 Verification Gate. Verify: .runs/verify-report.md exists. Read it and check: agents_expected equals agents_completed; if 2+ implementer agents spawned, consistency_scan is not 'skipped'; if fix cycles ran, auto_observe is not 'skipped-no-fixes'; build result is pass; unless quality: mvp — if spec-reviewer in agents_completed, spec-reviewer verdict is not FAIL." If gate-keeper returns BLOCK: if the block reason is spec-reviewer FAIL, read the spec-reviewer findings from `.runs/verify-report.md` — the implementation is missing features, so go back to STATE 10 (IMPLEMENT) to add the missing behaviors/pages/endpoints/events, then re-run STATE 11 (VERIFY). For all other blocks, go back and complete Step 7.

- You are already on a feature branch (created in Step 0). Do not create another branch.
- Commit message: imperative mood describing the change (e.g., "Add invoice email reminders", "Fix email validation on signup form", "Polish landing copy and error states")
- **G6 PR Gate**: Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute G6 PR Gate. Verify: on feature branch (not main), `git status` shows no uncommitted changes to tracked files, commit message follows imperative mood convention." If gate-keeper returns BLOCK, fix blocking items before pushing.
- Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md` format:
  - **Summary**: plain-English description of the change
  - **How to Test**: steps to verify the change works after merging
  - **What Changed**: list every file created/modified and what changed
  - **Why**: how this change serves the target user and thesis. If from a GitHub issue, include `Closes #<number>`.
  - **Checklist — Scope**: check all boxes. For new behaviors: confirm experiment.yaml was updated.
  - **Checklist — Analytics**: list all new/modified events and which pages fire them. For fixes/polish: confirm no events were removed or broken.
  - **Checklist — Build**: confirm build passes, no hardcoded secrets
  - **Checklist — Verification**: populate from `.runs/verify-report.md` contents. If Step 7 was skipped or partially run, state why.
- Fill in **every** section of the PR template. Empty sections are not acceptable. If a section does not apply, write "N/A" with a one-line reason.
  - **Skill Deficiency Analysis** (Fix type only): If `.runs/change-context.json` contains `skill_deficiency` that is not null AND `classification` is "Fix", add this section to the PR body after the Verification checklist:
    ```
    ## Skill Deficiency Analysis
    - **Defect Category**: <code> (<description from skill-coverage-map.md>)
    - **Should Have Been Caught By**:
      - `/<skill>` STATE <N> (<state-name>) — <reason>
    - **Attribution Confidence**: <high|medium|low>
    - **Recommendation**: <what the responsible skill/state should do differently>
    ```
    If `skill_deficiency` is null, `defect_category` is "unclassified", or type is not Fix: omit this section entirely.
- If `git push` or `gh pr create` fails: show the error and tell the user to check their GitHub authentication (`gh auth status`) and remote configuration (`git remote -v`), then retry.
### Q-score

Compute change execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/change-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
PLAN_COMPLETE=$(grep -c '\- \[x\]' .runs/current-plan.md 2>/dev/null || echo "0")
PLAN_TOTAL=$(grep -c '\- \[.\]' .runs/current-plan.md 2>/dev/null || echo "1")
Q_PLAN=$(python3 -c "print(round(int('${PLAN_COMPLETE}') / max(int('${PLAN_TOTAL}'), 1), 3))")
python3 .claude/scripts/write-q-score.py \
  --skill change --scope change \
  --archetype "$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('type','web-app'))" 2>/dev/null || echo web-app)" \
  --gate 1.0 --dims "{\"plan\": $Q_PLAN, \"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

- Delete `.runs/current-plan.md`, `.runs/verify-report.md`, and `.runs/agent-traces/` (if it exists) — the plan is captured in the PR description and the verification results are in the PR checklist. Note: plan deletion happens AFTER Step 7 completes (spec-reviewer needs the plan during verification).
- **Save planning patterns**: If this change revealed planning-relevant patterns (auth flow interactions, stack integration quirks, codebase conventions discovered during exploration, schema design patterns), save a brief entry to auto memory under a "Planning Patterns" heading. These get consulted during future Phase 1 exploration via `.claude/procedures/plan-exploration.md` Step 5.
- Tell the user: "Change PR created. Next: review and merge to `main`. Run `/verify` to confirm tests pass." If the archetype is `cli`, add: "CLIs are distributed via `npm publish` or GitHub Releases — see the archetype file. After merging this PR to `main`, bump the version in `package.json` and run `npm publish` to release the update. If this change modified the marketing surface, also run `/deploy` to push the updated surface to production. After publishing and collecting usage data, run `/iterate` to review metrics, or `/retro` when ready to wrap up." Otherwise, add: "Then run `/deploy` if not yet deployed."

**POSTCONDITIONS:**
- G5 Verification Gate passed
- G6 PR Gate passed
- All changes committed
- Branch pushed to remote
- PR created with all template sections filled
- `.runs/current-plan.md`, `.runs/verify-report.md`, `.runs/agent-traces/` deleted
- Planning patterns saved to auto memory (if applicable)

**VERIFY:**
```bash
git status --porcelain | grep -v '??' | wc -l | xargs test 0 -eq && echo "Clean" || echo "Uncommitted changes"
git log -1 --oneline && echo "Commit OK"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh change 12
```

**NEXT:** TERMINAL — PR created, tell user next steps.
