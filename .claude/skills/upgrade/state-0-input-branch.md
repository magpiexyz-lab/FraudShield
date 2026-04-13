# STATE 0: INPUT_BRANCH_SETUP

**PRECONDITIONS:**
- Git repository exists in working directory
- GitHub CLI (`gh`) is authenticated

**ACTIONS:**

Parse `$ARGUMENTS` for the `--dry-run` flag. If present, set `dry_run = true` in the context file.

Create the upgrade branch:
```bash
git checkout -b chore/upgrade-template
```

Auto-add `template` remote if missing:
```bash
if ! git remote get-url template &>/dev/null; then
  git remote add template https://github.com/magpiexyz-lab/mvp-template.git
fi
```

Fetch template:
```bash
git fetch template
```

### Resolve sync base

Determine the last-synced template commit for orphan detection:
```bash
if [ -f .claude/template-sync-meta.json ]; then
  SYNC_BASE=$(python3 -c "import json; print(json.load(open('.claude/template-sync-meta.json'))['last_synced_commit'])")
else
  # First overwrite-based upgrade: fall back to merge-base (works because prior upgrades used --merge)
  SYNC_BASE=$(git merge-base HEAD template/main 2>/dev/null || echo "")
fi
```

Clean stale skill artifacts and merge upgrade-specific fields into context:
```bash
rm -f .runs/upgrade-*.json
bash .claude/scripts/init-context.sh upgrade '{"dry_run":false}'
```

Store sync_base and dry_run in the context file:
```bash
python3 -c "
import json
d = json.load(open('.runs/upgrade-context.json'))
d['sync_base'] = '$SYNC_BASE'
d['dry_run'] = False
json.dump(d, open('.runs/upgrade-context.json', 'w'), indent=2)
"
```

If `--dry-run` was specified, update the context file:
```bash
python3 -c "
import json
d = json.load(open('.runs/upgrade-context.json'))
d['dry_run'] = True
json.dump(d, open('.runs/upgrade-context.json', 'w'), indent=2)
"
```

**POSTCONDITIONS:**
- `.runs/upgrade-context.json` exists
- On `chore/upgrade-template` branch
- `template` remote is configured and fetched

**VERIFY:**
```bash
test -f .runs/upgrade-context.json && git branch --show-current | grep -q 'chore/upgrade-template'
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh upgrade 0
```

**NEXT:** Read [state-1-merge-validate.md](state-1-merge-validate.md) to continue.
