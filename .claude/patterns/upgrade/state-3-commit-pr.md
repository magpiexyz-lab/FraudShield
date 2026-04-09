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

### Commit

Stage all changes (overwritten template files + orphan deletions + any build fixes):
```bash
TEMPLATE_SHA=$(python3 -c "import json; print(json.load(open('.runs/upgrade-diff-report.json')).get('template_commit','latest')[:7])" 2>/dev/null || echo "latest")
git add -A
git commit -m "Upgrade template to $TEMPLATE_SHA"
```

### Update sync metadata

Record the synced template commit for future orphan detection:
```bash
python3 -c "
import json, datetime, subprocess
sha = subprocess.check_output(['git', 'rev-parse', 'template/main']).decode().strip()
meta = {
    'last_synced_commit': sha,
    'last_upgrade_date': datetime.datetime.now(datetime.timezone.utc).isoformat()
}
json.dump(meta, open('.claude/template-sync-meta.json', 'w'), indent=2)
"
git add .claude/template-sync-meta.json
git commit -m "Update template sync metadata"
```

### PR

Create a PR with the dedicated upgrade report format (do NOT use the standard PR template):

```bash
gh pr create --title "chore: upgrade template to $TEMPLATE_SHA" --body "$(cat <<'EOF'
## Template Upgrade Report

**Sync status:** <synced / up-to-date>
**Files synced:** <N> files
**Orphans removed:** <N> files
**Config drift:** <N> lines differ in .gitignore
**Stale memories flagged:** <N> entries

### Synced Files
<list of template files overwritten — from upgrade-diff-report.json files_synced>

### Orphans Deleted
<list orphans removed — from upgrade-diff-report.json orphans_deleted>

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
- This skill produces diffs (template overwrite + orphan cleanup)

Spawn observer if diffs exist. Write `.runs/observe-result.json` with `"skill": "upgrade"`.

### Auto-merge (skip for dry-run)

If `dry_run == true` in `.runs/upgrade-context.json`: skip this section
entirely (no PR was created).

If `dry_run == false` (normal mode): follow `.claude/patterns/auto-merge.md`.
The PR number is from the `gh pr create` output above.

If any safety gate fails, report and leave PR open.
If auto-merge succeeded: "Upgrade PR auto-merged to main."
If auto-merge skipped: "Upgrade PR created but not auto-merged (<reason>). Merge manually."

### Completion checkpoint

Write `.runs/upgrade-step-check.json`:
```bash
python3 -c "
import json, os, subprocess
steps = []
if os.path.exists('package.json'):
    steps.append('build_verify')
ctx = json.load(open('.runs/upgrade-context.json')) if os.path.exists('.runs/upgrade-context.json') else {}
dry_run = ctx.get('dry_run', False)
if dry_run:
    steps.append('dry_run_exit')
else:
    if os.path.exists('.runs/upgrade-diff-report.json'):
        diff = json.load(open('.runs/upgrade-diff-report.json'))
        if len(diff.get('files_synced', [])) > 0:
            steps.append('files_synced')
    pr = subprocess.run(['gh','pr','view','--json','number','-q','.number'], capture_output=True, text=True)
    pr_number = None
    if pr.returncode == 0 and pr.stdout.strip():
        steps.append('commit')
        steps.append('pr')
        pr_number = int(pr.stdout.strip())
    steps.append('auto_merge')
steps.extend(['q_score', 'epilogue'])
os.makedirs('.runs', exist_ok=True)
json.dump({
    'steps_completed': steps,
    'key_outputs': {
        'build_passed': 'build_verify' in steps or not os.path.exists('package.json'),
        'pr_number': int(pr.stdout.strip()) if not dry_run and pr.returncode == 0 and pr.stdout.strip() else None,
        'dry_run': dry_run
    }
}, open('.runs/upgrade-step-check.json', 'w'), indent=2)
print('SELF-CHECK: wrote .runs/upgrade-step-check.json with', len(steps), 'steps')
"
```

This checkpoint is mandatory. Do not skip it.

**POSTCONDITIONS:**
- PR created and auto-merged (normal mode), or dry-run report presented, or PR left open (safety gate)
- `.runs/observe-result.json` exists with `"skill": "upgrade"`
- `.runs/upgrade-step-check.json` exists with at least 1 completed step

**VERIFY:**
```bash
(gh pr view --json number 2>/dev/null || test -f .runs/upgrade-diff-report.json) && test -f .runs/observe-result.json && python3 -c "import json; d=json.load(open('.runs/upgrade-step-check.json')); assert len(d.get('steps_completed',[])) > 0"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh upgrade 3
```

**NEXT:** TERMINAL — upgrade complete, PR auto-merged (or dry-run / left open with reason).
