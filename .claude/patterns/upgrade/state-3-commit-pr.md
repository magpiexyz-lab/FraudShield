# STATE 3: COMMIT_PR

**PRECONDITIONS:**
- State 2 complete (`.runs/upgrade-memory-report.json` exists)

**ACTIONS:**

Read `.runs/upgrade-context.json` to check the `dry_run` flag.

### Build verification

If a `package.json` exists, run the build:
```bash
npm run build
```

If the build fails, apply the standard 3-attempt fix loop:
1. Read the error output
2. Fix the issue
3. Re-run `npm run build`
Repeat up to 3 times. If still failing after 3 attempts, report the error and continue.

### Dry-run exit

If `dry_run == true`:
- Present the combined report from States 1-2 to the user (read `.runs/upgrade-diff-report.json` and `.runs/upgrade-memory-report.json`)
- Write `.runs/observe-result.json`:
  ```json
  {
    "skill": "upgrade",
    "timestamp": "<ISO 8601>",
    "friction_detected": false,
    "observations_filed": 0,
    "verdict": "clean"
  }
  ```
- **STOP.** Do not commit or create a PR. Present the report and end.

### Orphan cleanup

Read orphans from `.runs/upgrade-diff-report.json`.

If orphans exist:
- Present the list to the user:
  ```
  The following orphan files were removed by the template but still exist in your project:
    - .claude/old/removed-file.md
    - .claude/old/another-file.md
  Delete these files? (Confirm each or all)
  ```
- Only delete files the user explicitly confirms
- Do NOT delete without confirmation

### Missing file restoration

Read missing from `.runs/upgrade-diff-report.json`.

If missing template-owned files exist:
- Present the list to the user:
  ```
  The following template files are missing from your project (possibly deleted during a prior cleanup):
    - .claude/orchestration/missing-file.json
  Restore these files from the template? (Confirm each or all)
  ```
- For each confirmed file: `git show template/main:<path> > <path>`
- Only restore files the user explicitly confirms
- Do NOT restore without confirmation

### Commit

Stage all changes (merged files + orphan deletions + any build fixes):
```bash
git add -A
git commit -m "Upgrade template to latest"
```

### PR

Create a PR with the dedicated upgrade report format (do NOT use the standard PR template):

```bash
gh pr create --title "chore: upgrade template to latest" --body "$(cat <<'EOF'
## Template Upgrade Report

**Merge status:** <clean / conflict>
**Orphans removed:** <N> files
**Config drift:** <N> lines differ in .gitignore
**Stale memories flagged:** <N> entries

### Structural Changes
<list orphans removed, missing files flagged, content diffs noted — from upgrade-diff-report.json>

### Memory Reconciliation
<list stale entries found and actions taken — from upgrade-memory-report.json>

### Config Drift
<.gitignore differences — template additions and project additions>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Fill in the actual values from the report JSON files.

### Q-score

Compute upgrade execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/upgrade-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 .claude/scripts/write-q-score.py \
  --skill upgrade --scope upgrade --archetype N/A \
  --gate 1.0 --dims '{"completion": 1.0}' \
  --run-id "$RUN_ID" || true
```

### Strategy A epilogue

Follow `.claude/patterns/skill-epilogue.md` **Strategy A** (Code Observation).

Inputs for Strategy A:
- Context file: `.runs/upgrade-context.json`
- Expected completed states: `[0, 1, 2]` (from state-registry.json)
- This skill produces diffs (template merge + orphan cleanup)

Spawn observer if diffs exist. Write `.runs/observe-result.json` with `"skill": "upgrade"`.

**POSTCONDITIONS:**
- PR created (or dry-run report presented)
- `.runs/observe-result.json` exists with `"skill": "upgrade"`

**VERIFY:**
```bash
gh pr view --json number 2>/dev/null || test -f .runs/upgrade-diff-report.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh upgrade 3
```

**NEXT:** TERMINAL -- the /upgrade skill is complete.
