---
description: "Use for any modification to an existing bootstrapped app: new features, bug fixes, UI polish, analytics fixes, or adding tests."
type: code-writing
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - CLAUDE.md
stack_categories: [framework, database, auth, analytics, ui, payment, email, testing, hosting]
requires_approval: true
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
  - .claude/patterns/messaging.md
  - .claude/patterns/design.md
  - .claude/patterns/solve-reasoning.md
  - .claude/procedures/plan-exploration.md
  - .claude/procedures/plan-validation.md
branch_prefix: change
modifies_specs: true
---
Make a change to the existing app: $ARGUMENTS

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | PRE_FLIGHT | Plan | [state-0-pre-flight.md](../patterns/change/state-0-pre-flight.md) |
| 1 | BRANCH_SETUP | Plan | [state-1-branch-setup.md](../patterns/change/state-1-branch-setup.md) |
| 2 | READ_CONTEXT | Plan | [state-2-read-context.md](../patterns/change/state-2-read-context.md) |
| 3 | SOLVE_REASONING | Plan | [state-3-solve-reasoning.md](../patterns/change/state-3-solve-reasoning.md) |
| 4 | CLASSIFY | Plan | [state-4-classify.md](../patterns/change/state-4-classify.md) |
| 5 | CHECK_PRECONDITIONS | Plan | [state-5-check-preconditions.md](../patterns/change/state-5-check-preconditions.md) |
| 6 | PRESENT_PLAN | Plan | [state-6-present-plan.md](../patterns/change/state-6-present-plan.md) |
| 7 | USER_APPROVAL | Plan | [state-7-user-approval.md](../patterns/change/state-7-user-approval.md) |
| 8 | PHASE2_PREFLIGHT | Implement | [state-8-phase2-preflight.md](../patterns/change/state-8-phase2-preflight.md) |
| 9 | UPDATE_SPECS | Implement | [state-9-update-specs.md](../patterns/change/state-9-update-specs.md) |
| 10 | IMPLEMENT | Implement | [state-10-implement.md](../patterns/change/state-10-implement.md) |
| 11 | VERIFY | Implement | [state-11-verify.md](../patterns/change/state-11-verify.md) |
| 12 | COMMIT_AND_PR | Implement | [state-12-commit-and-pr.md](../patterns/change/state-12-commit-and-pr.md) |

Begin at STATE 0. Read [state-0-pre-flight.md](../patterns/change/state-0-pre-flight.md) now.

## Do NOT
- Add more than what `$ARGUMENTS` describes — one change per PR
- Modify existing behaviors unless the change requires integration (e.g., adding a nav link)
- Remove or break existing analytics events (unless the change is specifically about fixing analytics)
- Add libraries not in experiment.yaml `stack` without user approval
- Skip updating experiment.yaml when adding new behaviors — the source of truth must always reflect the current app
- Change analytics event names — they must match experiment/EVENTS.yaml
- Add analytics events without user approval
- Add error-state tests — funnel happy path only (Rule 4)
- Mock services in tests — the whole point is testing real integrations
- Skip Step 7 verification (verify.md must run with the classified scope — build loop and auto-observe always run; review agents run per scope)
- Commit to main directly
