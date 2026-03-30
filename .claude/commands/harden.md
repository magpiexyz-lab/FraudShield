---
description: "Transition an MVP to production quality mode. Scans code, plans hardening, adds specification tests to critical paths."
type: code-writing
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - CLAUDE.md
stack_categories: [framework, database, auth, analytics, testing]
requires_approval: true
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/tdd.md
  - .claude/patterns/observe.md
  - .claude/patterns/recovery.md
  - .claude/agents/implementer.md
branch_prefix: chore
modifies_specs: true
---
Transition this MVP to production quality mode: $ARGUMENTS

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | VALIDATE_PRECONDITIONS | Plan | [state-0-validate-preconditions.md](../patterns/harden/state-0-validate-preconditions.md) |
| 1 | SCAN_AND_CLASSIFY | Plan | [state-1-scan-and-classify.md](../patterns/harden/state-1-scan-and-classify.md) |
| 2 | PRESENT_PLAN | Plan | [state-2-present-plan.md](../patterns/harden/state-2-present-plan.md) |
| 3 | USER_APPROVAL | Plan | [state-3-user-approval.md](../patterns/harden/state-3-user-approval.md) |
| 4 | BRANCH_AND_CONFIG | Implement | [state-4-branch-and-config.md](../patterns/harden/state-4-branch-and-config.md) |
| 5 | MODULE_LOOP | Implement | [state-5-module-loop.md](../patterns/harden/state-5-module-loop.md) |
| 6 | RECONCILE | Implement | [state-6-reconcile.md](../patterns/harden/state-6-reconcile.md) |
| 7 | PERSIST_ON_TOUCH | Implement | [state-7-persist-on-touch.md](../patterns/harden/state-7-persist-on-touch.md) |
| 8 | VERIFY | Implement | [state-8-verify.md](../patterns/harden/state-8-verify.md) |
| 9 | COMMIT_AND_PR | Implement | [state-9-commit-and-pr.md](../patterns/harden/state-9-commit-and-pr.md) |

Begin at STATE 0. Read [state-0-validate-preconditions.md](../patterns/harden/state-0-validate-preconditions.md) now.

## Key Design Decisions
- Dependency-ordered sequential execution — fail-fast prevents cascading breakage, dependencies satisfied before dependents
- Implementer agents use `isolation: "worktree"` per Agent tool pattern
- Implementers receive the "Specifications to test" list from the plan — no re-derivation needed
- Spec-reviewer included in verify step (conditional 6th agent)
- Re-run detection: `quality: production` already set + no $ARGUMENTS → stop. To add more specification tests to an already-hardened project, pass a scope argument (e.g., `/harden auth module`)
- Checkpoint-based resume: `.claude/current-plan.md` with YAML frontmatter enables exact resume after /clear or context overflow

## Do NOT
- Skip the approval step (Step 2) — the user must review the hardening plan
- Harden UI-only components or static content — specification tests add no value there
- Run modules in parallel — sequential execution prevents cascading breakage
- Skip the verify step — spec-reviewer must validate test-to-spec alignment
- Add tests for hypothetical edge cases — test what the code SHOULD do per experiment.yaml
- Commit to main directly
