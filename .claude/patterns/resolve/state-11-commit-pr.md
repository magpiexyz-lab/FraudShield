# STATE 11: COMMIT_PR

**PRECONDITIONS:**
- Skill epilogue complete (STATE 10 POSTCONDITIONS met)

**ACTIONS:**

Read `resolve-context.json` and check the `mode` field.

**If `mode == "refine"`:**
- Commit message: `Refine: <improvement description>\n\nFixes #N, #M`
- PR title: `Refine: <skill> state improvements`
- All other PR body sections (Root Cause Analysis, Blast Radius, etc.) remain the same

**If `mode` is not `"refine"`:** use the normal format below.

Commit all changes with message: `Fix #N: <imperative description>`
(or `Fix #N, #M: <description>` for multiple issues).

Push and open PR using `.github/PULL_REQUEST_TEMPLATE.md`:

- **Summary**: For each issue resolved:
  - Issue number and title
  - Root cause (1 sentence)
  - What changed
- **How to Test**: "Run `make validate` + all 3 validator scripts"
- **What Changed**: List every file and what changed
- **Why**: "Resolves template issues reported in #N" with `Closes #N` for each issue

Include additional sections in PR body:

### Root Cause Analysis
For each issue: root cause, divergence point, and why the fix addresses it.

### Blast Radius
Files checked, confirmed matches fixed, potential matches evaluated.

### Validator Additions
New checks added (if any), with name, target script, and pass/fail criteria.
If none: "No new checks — pattern is unlikely to recur."

### Validator Evidence
| Issue | Pre-Fix Errors | Post-Fix Errors | Delta |
|-------|---------------|-----------------|-------|
| #N    | <cited errors or "none"> | <errors or "none"> | -K |

### Adversarial Review
| Issue | Label | Challenge Summary |
|-------|-------|-------------------|
| #N    | sound | Tested 3 fixture configs, no breakage |

### Cross-Issue Correlation
- Cluster 1: #A, #B — shared root cause: <pattern>. Single fix.
- Uncorrelated: #C
(Or: "Single issue — no correlation analysis")

### Potentially Resolved
(From Step 8b, or "None — no side-effect matches detected")

### Auto-merge

Follow `.claude/patterns/auto-merge.md`. The PR number is from the `gh pr create`
output above.

If any safety gate fails, report the failure and leave the PR open — tell the
user to merge manually.

If auto-merge succeeded: "Resolve PR auto-merged to main. Issues closed."
If auto-merge skipped: "Resolve PR created but not auto-merged (<reason>). Merge manually."

### Worktree Cleanup

If you entered a worktree in STATE 0:

1. Copy Q-score back to main checkout:
```bash
MAIN_DIR=$(git worktree list | head -1 | awk '{print $1}')
mkdir -p "$MAIN_DIR/.runs"
tail -1 .runs/verify-history.jsonl >> "$MAIN_DIR/.runs/verify-history.jsonl" 2>/dev/null || true
```

2. Call the `ExitWorktree` tool with `action: "remove"` and `discard_changes: true` to return to the main checkout and delete the worktree. This is safe because all commits have been pushed to the remote and the PR has been created.

If you did NOT enter a worktree (EnterWorktree failed in STATE 0): skip this section.

**POSTCONDITIONS:**
- All changes committed
- PR opened with full template sections
- `Closes #N` in PR body for each resolved issue
- Auto-merge completed (or intentionally skipped with reason reported)

**VERIFY:**
```bash
(gh pr view --json number 2>/dev/null || git branch --show-current | grep -qE '^main$') && test -f .runs/observe-result.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 11
```

**NEXT:** TERMINAL — resolve complete, PR auto-merged (or left open with reason).
