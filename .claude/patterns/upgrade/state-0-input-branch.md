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

Auto-discover `template` remote if missing:
```bash
# Check if template remote exists
if ! git remote get-url template >/dev/null 2>&1; then
  # Find template repo via GitHub API
  CURRENT_REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null)
  if [ -n "$CURRENT_REPO" ]; then
    TEMPLATE_REPO=$(gh api "repos/$CURRENT_REPO" \
      --jq '.template_repository.full_name // .parent.full_name // empty' 2>/dev/null)
    if [ -n "$TEMPLATE_REPO" ]; then
      git remote add template "https://github.com/$TEMPLATE_REPO.git"
    fi
  fi
fi
```

If `template` remote still not found, stop with error: "No template remote configured. Add it manually: `git remote add template <url>`"

Fetch template:
```bash
git fetch template
```

Clean stale artifacts and create context file:
```bash
rm -f .runs/upgrade-*.json .runs/observe-result.json

cat > .runs/upgrade-context.json << CTXEOF
{"skill":"upgrade","branch":"chore/upgrade-template","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[],"dry_run":false}
CTXEOF
```

If `--dry-run` was specified, update the context file:
```bash
python3 -c "
import json
d = json.load(open('.runs/upgrade-context.json'))
d['dry_run'] = True
json.dump(d, open('.runs/upgrade-context.json', 'w'))
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
