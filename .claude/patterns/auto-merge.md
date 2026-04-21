# Auto-Merge Procedure

Auto-merge is executed centrally by `lifecycle-finalize.sh` after delivery gate
checks pass. Individual skills no longer call auto-merge directly — they write
delivery artifacts (`.runs/commit-message.txt`, `.runs/pr-title.txt`,
`.runs/pr-body.md`) and finalize handles commit, push, PR creation, and merge.

This document defines the procedure that `lifecycle-finalize.sh` implements.
The PR exists for audit trail (Rule 1) and is merged immediately after creation.

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

`verify-pr-gate.sh` blocks PR creation without passing runtime verification.
But `/verify`'s scope is build + runtime agents — it does NOT run the
template-lint validators that CI runs (`validate-semantics.py`,
`validate-convergence-config.py`, `consistency-check.sh`, etc.). A PR
that passes `/verify` but contains a `.claude/` edit with a semantic
defect will be auto-merged and CI will fail on main.

### Gate 4: Template-lint parity (when PR touches `.claude/`)

```bash
if git diff --name-only "$(git merge-base main HEAD)..HEAD" | grep -q '^\.claude/'; then
  if ! make lint-template; then
    echo "make lint-template failed — skipping auto-merge."
    echo "Fix the template-lint failures locally, then re-push."
    # SKIP — do not merge
  fi
fi
```

Why: `make lint-template` mirrors the CI workflow's validator set (see
`.github/workflows/ci.yml` and `.github/workflows/stack-knowledge-validate.yml`).
Running it locally before merge prevents broken template changes from
landing on main and avoids the follow-up-fix-PR pattern.

## Merge

```bash
FEATURE_BRANCH=$(git branch --show-current)

# All skills use --squash for clean single-commit history.
# /upgrade tracks sync state via .claude/template-sync-meta.json instead of merge ancestry.
if [[ -n "${CLAUDE_WORKTREE:-}" ]]; then
  # In worktree: --delete-branch triggers local checkout of main which fails
  # (main is checked out in primary worktree). Branch is cleaned up by ExitWorktree.
  gh pr merge --squash
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
if [[ -z "${CLAUDE_WORKTREE:-}" ]]; then
  git checkout main && git pull
  git branch -d "$FEATURE_BRANCH" 2>/dev/null || true
fi
# In worktree: skip local checkout — ExitWorktree handles cleanup.
```

After merge completes:
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
