# STATE 9: COMMIT_AND_PR

**PRECONDITIONS:**
- STATE 8 POSTCONDITIONS met (verification complete, report exists)

**ACTIONS:**

**Gate check:** Read `.claude/verify-report.md`. If it does not exist, STOP -- go back and run STATE 8 above. Do NOT commit without a verification report.

### Q-score

Compute harden execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.claude/harden-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 .claude/scripts/write-q-score.py \
  --skill harden --scope harden \
  --archetype "$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('type','web-app'))" 2>/dev/null || echo web-app)" \
  --gate 1.0 --dims "{\"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

- You are already on a `chore/harden-*` branch (created in STATE 4). Do not create another branch.
- Commit message: imperative mood describing the hardening (e.g., "Add specification tests for auth and payment flows")
- Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md` format:
  - **Summary**: what modules were hardened and why (quality: production)
  - **What Changed**: list every file created/modified (spec files, on-touch.yaml, etc.)
  - **Checklist — Build**: confirm build passes, no hardcoded secrets
  - **Checklist — Verification**: populate from `.claude/verify-report.md` contents
- Fill in **every** section of the PR template. Empty sections are not acceptable. If a section does not apply, write "N/A" with a one-line reason.
- If `git push` or `gh pr create` fails: show the error and tell the user to check their GitHub authentication (`gh auth status`) and remote configuration (`git remote -v`), then retry.
- After PR is created, delete `.claude/current-plan.md` and `.claude/verify-report.md`.

Key design decisions:
- Dependency-ordered sequential execution -- fail-fast prevents cascading breakage, dependencies satisfied before dependents
- Implementer agents use `isolation: "worktree"` per Agent tool pattern
- Implementers receive the "Specifications to test" list from the plan -- no re-derivation needed
- Spec-reviewer included in verify step (conditional 6th agent)
- Re-run detection: `quality: production` already set + no $ARGUMENTS -> stop
- Checkpoint-based resume: `.claude/current-plan.md` with YAML frontmatter enables exact resume after /clear or context overflow

**Post-merge guidance.** After PR is created, tell the user:

```
Production quality mode is now active.
- All future /change Feature, Fix, and Upgrade changes use TDD automatically.
- On-touch modules will be hardened when you next /change them.
- Run /verify to confirm all tests pass.
```

**POSTCONDITIONS:**
- PR created with verification checklist populated
- `.claude/current-plan.md` deleted
- `.claude/verify-report.md` deleted
- Post-merge guidance displayed to user

**VERIFY:**
```bash
gh pr view --json number 2>/dev/null
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh harden 9
```

**NEXT:** TERMINAL -- PR created.
