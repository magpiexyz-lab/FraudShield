# Auto-Merge Procedure

Run this procedure after PR creation and all post-PR steps (Q-score, epilogue,
issue closure) are complete. The PR exists for audit trail (Rule 1) and is
merged immediately by the skill.

## Safety Gates

Run all three gates in order. If ANY gate fails, leave the PR open and report
the gate failure to the user. Do not proceed to merge.

### Gate 1: Migration guard

```bash
if gh pr diff --name-only | grep -q '^supabase/migrations/'; then
  echo "PR contains database migrations — skipping auto-merge."
  echo "Review migrations and merge manually."
  # SKIP — do not merge
fi
```

Why: CI runs `supabase db push` on push to main. Destructive migrations
(drop table/column) should be reviewed before hitting production.

### Gate 2: Secret scan (graceful)

```bash
if command -v gitleaks >/dev/null 2>&1; then
  if ! gitleaks detect --source . --no-banner --exit-code 1 2>/dev/null; then
    echo "gitleaks detected potential secrets — skipping auto-merge."
    echo "Review findings and merge manually."
    # SKIP — do not merge
  fi
fi
# If gitleaks is not installed: PASS (proceed). This gate is advisory.
```

Why: CI runs gitleaks on PRs. Local verification uses LLM-based security
review which may miss secrets that deterministic scanning catches.

### Gate 3: Build verification

No additional check needed. The verify-pr-gate.sh hook already blocks PR
creation without passing verification. If the PR was created, this gate
is satisfied.

## Merge

```bash
FEATURE_BRANCH=$(git branch --show-current)

# Detect active skill from context files
ACTIVE_SKILL=$(python3 -c "
import json, glob, os
best_skill, best_ts = '', ''
for cf in glob.glob('.runs/*-context.json'):
    if 'epilogue' in cf: continue
    try:
        d = json.load(open(cf))
        ts = d.get('timestamp', '')
        if ts > best_ts:
            best_ts = ts
            best_skill = d.get('skill', '')
    except: pass
print(best_skill)
" 2>/dev/null || echo "")

# /upgrade needs --merge to preserve two-parent ancestry for git merge-base.
# All other skills use --squash for clean single-commit history.
if [ "$ACTIVE_SKILL" = "upgrade" ]; then
  gh pr merge --merge --delete-branch
else
  gh pr merge --squash --delete-branch
fi
```

If `gh pr merge` fails:
- Report the error to the user
- Common causes: branch protection requires reviews, merge conflicts
- Leave the PR open — do not retry
- The skill still reaches TERMINAL with the skip reason reported

## Post-Merge

```bash
git checkout main && git pull
git branch -d "$FEATURE_BRANCH" 2>/dev/null || true
```

After switching to main:
1. Report: "PR #N auto-merged to main."
2. Surface the skill's next-step guidance (deploy, publish, etc.)

## Skip Conditions

Skills skip auto-merge entirely when:
- **Upgrade dry-run**: No PR was created (`dry_run == true`)
- **Review no-findings**: No branch exists (no findings across iterations)
- **Any safety gate fails**: PR left open with reason reported

## User-Facing Messages

When auto-merge succeeds:
> PR #N auto-merged to main. [skill-specific next steps]

When auto-merge is skipped:
> PR created but not auto-merged: [reason]. Review and merge manually.
