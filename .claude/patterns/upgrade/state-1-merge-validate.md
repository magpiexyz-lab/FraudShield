# STATE 1: OVERWRITE_VALIDATE

**PRECONDITIONS:**
- State 0 complete (`.runs/upgrade-context.json` exists, on `chore/upgrade-template` branch)
- `template` remote fetched

**ACTIONS:**

Read `.runs/upgrade-context.json` to get the `dry_run` flag and `sync_base`.

### Read template-owned paths

Read the canonical list of template-owned paths:
```bash
TEMPLATE_PATHS=$(cat .claude/template-owned-dirs.txt | grep -v '^#' | grep -v '^$' | tr '\n' ' ')
```

### Pre-compute changed files

Compute which template-owned files actually differ between HEAD and template/main:
```bash
CHANGED=$(git diff --name-only HEAD template/main -- $TEMPLATE_PATHS)
```

If `CHANGED` is empty, set `sync_status = "up-to-date"` and skip to Output.

If `dry_run == true`, set `sync_status = "dry-run"` and skip to Output (but still compute the full diff report).

### Overwrite changed files

If `dry_run == false` and changed files exist:
```bash
echo "$CHANGED" | xargs git checkout template/main --
```

This stages the changes directly. No conflicts are possible — overwrite is unconditional.

Set `sync_status = "synced"`.

### Orphan detection

Orphans are files the template REMOVED since the last sync that still exist locally.

```bash
SYNC_BASE=$(python3 -c "import json; print(json.load(open('.runs/upgrade-context.json')).get('sync_base',''))")

if [ -n "$SYNC_BASE" ]; then
  # Files the template removed since last sync
  REMOVED=$(git diff --diff-filter=D --name-only $SYNC_BASE..template/main -- $TEMPLATE_PATHS)
  # Check which removed files still exist locally
  ORPHANS=""
  for f in $REMOVED; do
    test -f "$f" && ORPHANS="$ORPHANS $f"
  done
fi
```

If `dry_run == false` and orphans exist:
- Present the list to the user:
  ```
  The following template files were removed upstream but still exist locally:
    - .claude/patterns/old-file.md
  Delete these files? (Confirm each or all)
  ```
- Only delete files the user explicitly confirms
- Stage confirmed deletions with `git rm`

### Config drift detection

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
  "sync_status": "synced",
  "files_synced": ["list of files checked out from template"],
  "orphans": ["list of orphaned files detected"],
  "orphans_deleted": ["list of orphans user confirmed for deletion"],
  "config_drift": {
    "gitignore": {
      "project_additions": [],
      "template_additions": []
    }
  },
  "template_commit": "<sha of template/main>"
}
```

**POSTCONDITIONS:**
- `.runs/upgrade-diff-report.json` exists with valid JSON containing all required fields

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/upgrade-diff-report.json')); assert d.get('sync_status') in ('synced','up-to-date','dry-run'), 'sync_status invalid: %s' % d.get('sync_status'); assert isinstance(d.get('files_synced'), list), 'files_synced not list'; assert all(isinstance(f, str) for f in d['files_synced']), 'files_synced items not strings'; assert isinstance(d.get('orphans'), list), 'orphans not list'; assert all(isinstance(o, str) for o in d['orphans']), 'orphans items not strings'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh upgrade 1
```

**NEXT:** Read [state-2-memory-reconcile.md](state-2-memory-reconcile.md) to continue.
