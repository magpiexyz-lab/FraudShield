---
description: "Handle template sync: overwrite template-owned files, validate structural consistency, reconcile stale memory, and open a PR."
type: code-writing
reads:
  - CLAUDE.md
stack_categories: []
requires_approval: false
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/skill-epilogue.md
  - .claude/patterns/observe.md
branch_prefix: chore
modifies_specs: false
---
Upgrade the project to the latest template version. $ARGUMENTS

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | INPUT_BRANCH_SETUP | Setup | [state-0-input-branch.md](../patterns/upgrade/state-0-input-branch.md) |
| 1 | OVERWRITE_VALIDATE | Validate | [state-1-merge-validate.md](../patterns/upgrade/state-1-merge-validate.md) |
| 2 | MEMORY_RECONCILE | Reconcile | [state-2-memory-reconcile.md](../patterns/upgrade/state-2-memory-reconcile.md) |
| 3 | COMMIT_PR | Commit | [state-3-commit-pr.md](../patterns/upgrade/state-3-commit-pr.md) |

Begin at STATE 0. Read [state-0-input-branch.md](../patterns/upgrade/state-0-input-branch.md) now.

## Do NOT
- Auto-delete any files without explicit user confirmation
- Skip diagnostic steps (States 1-2) — the structural diff report is always valuable
- Modify project-owned files under `.claude/` that are outside the template-owned directory allowlist
- Use the standard PR template — upgrade PRs use a dedicated report format
