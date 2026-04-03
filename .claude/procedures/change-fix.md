# /change: Fix Implementation

> Invoked by change.md Step 6 when type is Fix.
> Read the full change skill at `.claude/commands/change.md` for lifecycle context.

## Prerequisites from change.md

- experiment.yaml and experiment/EVENTS.yaml have been read (Step 2)
- Change classified as Fix (Step 3)
- Preconditions checked (Step 4)
- Plan approved (Phase 1)
- Specs updated (Step 5)

## Implementation

- Unless `quality: mvp` is set in experiment.yaml:
  1. **ON-TOUCH check** (see `patterns/on-touch-check.md`): If `experiment/on-touch.yaml` exists: first, remove any entries whose `path` no longer exists on disk (stale from deleted modules). Then check if any files affected by the fix are listed as ON-TOUCH. For each match: add a prerequisite TDD task to write specification tests for the existing code in that file BEFORE writing the fix. Remove the entry from `experiment/on-touch.yaml` after tests are added. If `on_touch` list is now empty, delete `experiment/on-touch.yaml`.
  2. Generate TDD task: regression test demonstrating the bug + minimal fix, per `patterns/tdd.md` § Regression Tests
  3. Spawn implementer agent (`agents/implementer.md`, isolation: "worktree") → regression test (RED, fails on current code) → fix root cause (GREEN, minimal change) → commit
  4. Write implementer trace based on Output Contract (same procedure as `change-feature.md` step 6)
  5. **Merge worktree changes with verification** (same procedure as `change-feature.md` step 7, substeps a-e). Key steps:
     - Verify implementer committed (`git log --oneline main..<worktree-branch>`)
     - If no commit: re-spawn agent for commit-only (do NOT commit on behalf of the agent). Budget: 1 retry.
     - Merge: `git merge <worktree-branch> --no-ff -m "Merge implementer: <task-slug>"`
     - Verify merge: `git log --oneline -1` must show merge commit
     - Update trace: set `worktree_merged: true`
  6. Continue to Step 7
- If `quality: mvp` is set:
- Make the minimal change needed — smaller diffs are easier to review
- Fix only the root cause, no refactoring of surrounding code
- If the fix touches auth or payment code: add or update a test (per CLAUDE.md Rule 4)
- Check that analytics events on modified pages are still intact
