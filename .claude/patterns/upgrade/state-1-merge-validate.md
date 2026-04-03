# STATE 1: MERGE_VALIDATE

**PRECONDITIONS:**
- State 0 complete (`.runs/upgrade-context.json` exists, on `chore/upgrade-template` branch)
- `template` remote fetched

**ACTIONS:**

Read `.runs/upgrade-context.json` to check the `dry_run` flag.

### Merge step

If `dry_run == false`:
```bash
git merge template/main --no-edit
```
- On success: `merge_status = "clean"`
- On conflict: capture the conflict file list from stderr/stdout, then abort:
  ```bash
  git diff --name-only --diff-filter=U > /tmp/upgrade-conflicts.txt 2>/dev/null
  git merge --abort
  ```
  Set `merge_status = "conflict"`.

If `dry_run == true`: skip merge, set `merge_status = "dry-run"`.

### Orphan detection

Detect files the template has removed since the last sync but that still exist in the project:
```bash
MERGE_BASE=$(git merge-base HEAD template/main)
# Files the template REMOVED since last sync
REMOVED=$(git diff --diff-filter=D --name-only $MERGE_BASE..template/main -- .claude/)
# Check if project still has these removed files
for f in $REMOVED; do test -f "$f" && echo "ORPHAN: $f"; done
```

### Structural diff — template-owned directories only

Only compare files within these template-owned directories (allowlist):
- `.claude/commands/`
- `.claude/patterns/`
- `.claude/stacks/`
- `.claude/archetypes/`
- `.claude/hooks/`
- `.claude/scripts/`
- `.claude/agents/`
- `.claude/procedures/`
- `.claude/orchestration/`

Files outside these directories within `.claude/` (e.g., `agent-memory/`, `template-meta.json`) are project-owned — do not touch them.

For each template-owned directory, compare the file listing between the project and `template/main`:
```bash
# List files template has in this directory
git ls-tree -r --name-only template/main -- .claude/commands/ .claude/patterns/ .claude/stacks/ .claude/archetypes/ .claude/hooks/ .claude/scripts/ .claude/agents/ .claude/procedures/ .claude/orchestration/
```

Categorize each file:
- **Orphan**: template removed the file (in `$REMOVED` list above), project still has it → flag for auto-deletion with user confirmation
- **Missing**: template has the file, project doesn't, and merge didn't add it → flag as error
- **Content differs**: both have the file, content is different → show a brief diff summary, report only (likely project customization)

### Config reconciliation

Compare `.gitignore` line-by-line against the template version:
```bash
git show template/main:.gitignore > /tmp/template-gitignore.txt 2>/dev/null
```

Categorize each differing line as:
- **Template addition**: line exists in template but not in project `.gitignore`
- **Project addition**: line exists in project but not in template `.gitignore`

Report only — do not auto-modify `.gitignore`.

### Output

Write `.runs/upgrade-diff-report.json`:
```json
{
  "merge_status": "clean",
  "conflicts": [],
  "orphans": [".claude/old/removed-file.md"],
  "missing": [],
  "content_diffs": [{"file": ".claude/patterns/verify.md", "summary": "15 lines changed"}],
  "config_drift": {
    "gitignore": {
      "project_additions": ["/my-custom-dir/"],
      "template_additions": ["/.runs/"]
    }
  }
}
```

**POSTCONDITIONS:**
- `.runs/upgrade-diff-report.json` exists with valid JSON containing all required fields

**VERIFY:**
```bash
test -f .runs/upgrade-diff-report.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh upgrade 1
```

**NEXT:** Read [state-2-memory-reconcile.md](state-2-memory-reconcile.md) to continue.
