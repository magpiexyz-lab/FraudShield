---
description: "Use when starting a new experiment from a filled-in experiment.yaml. Run once per project."
type: code-writing
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - CLAUDE.md
stack_categories: [framework, database, auth, analytics, ui, payment, email, hosting, testing]
requires_approval: true
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
  - .claude/patterns/messaging.md
  - .claude/patterns/design.md
  - .claude/procedures/scaffold-setup.md
  - .claude/procedures/scaffold-init.md
  - .claude/procedures/scaffold-libs.md
  - .claude/procedures/scaffold-pages.md
  - .claude/procedures/scaffold-externals.md
  - .claude/procedures/scaffold-landing.md
  - .claude/procedures/wire.md
branch_prefix: feat
modifies_specs: false
---
Bootstrap the MVP from experiment.yaml.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | BRANCH_SETUP | Plan | [state-0-branch-setup.md](../patterns/bootstrap/state-0-branch-setup.md) |
| 1 | READ_CONTEXT | Plan | [state-1-read-context.md](../patterns/bootstrap/state-1-read-context.md) |
| 2 | RESOLVE_ARCHETYPE_STACK | Plan | [state-2-resolve-archetype.md](../patterns/bootstrap/state-2-resolve-archetype.md) |
| 3 | VALIDATE_EXPERIMENT | Plan | [state-3-validate-experiment.md](../patterns/bootstrap/state-3-validate-experiment.md) |
| 3a | BG1_GATE | Plan | [state-3a-bg1-gate.md](../patterns/bootstrap/state-3a-bg1-gate.md) |
| 3b | DUPLICATE_CHECK | Plan | [state-3b-duplicate-check.md](../patterns/bootstrap/state-3b-duplicate-check.md) |
| 4 | CHECK_PRECONDITIONS | Plan | [state-4-check-preconditions.md](../patterns/bootstrap/state-4-check-preconditions.md) |
| 5 | PRESENT_PLAN | Plan | [state-5-present-plan.md](../patterns/bootstrap/state-5-present-plan.md) |
| 6 | USER_APPROVAL | Plan | [state-6-user-approval.md](../patterns/bootstrap/state-6-user-approval.md) |
| 7 | SAVE_PLAN | Plan | [state-7-save-plan.md](../patterns/bootstrap/state-7-save-plan.md) |
| 8 | PREFLIGHT | Implement | [state-8-preflight.md](../patterns/bootstrap/state-8-preflight.md) |
| 9 | SETUP_PHASE | Implement | [state-9-setup-phase.md](../patterns/bootstrap/state-9-setup-phase.md) |
| 10 | DESIGN_PHASE | Implement | [state-10-design-phase.md](../patterns/bootstrap/state-10-design-phase.md) |
| 11 | PARALLEL_SCAFFOLD | Implement | [state-11-parallel-scaffold.md](../patterns/bootstrap/state-11-parallel-scaffold.md) |
| 12 | EXTERNALS_DECISIONS | Implement | [state-12-externals-decisions.md](../patterns/bootstrap/state-12-externals-decisions.md) |
| 13 | BUILD_VALIDATION | Implement | [state-13-merged-validation.md](../patterns/bootstrap/state-13-merged-validation.md) |
| 13a | ANALYTICS_DESIGN_CHECK | Implement | [state-13a-analytics-design-check.md](../patterns/bootstrap/state-13a-analytics-design-check.md) |
| 13b | CONTENT_SEO_CHECK | Implement | [state-13b-content-seo-check.md](../patterns/bootstrap/state-13b-content-seo-check.md) |
| 13c | BG2_GATE | Implement | [state-13c-bg2-gate.md](../patterns/bootstrap/state-13c-bg2-gate.md) |
| 14 | WIRE_PHASE | Implement | [state-14-wire-phase.md](../patterns/bootstrap/state-14-wire-phase.md) |
| 15 | SCAN_AND_CLASSIFY | Implement | [state-15-scan-and-classify.md](../patterns/bootstrap/state-15-scan-and-classify.md) |
| 16 | UNIT_TEST_GENERATION | Implement | [state-16-unit-test-generation.md](../patterns/bootstrap/state-16-unit-test-generation.md) |
| 17 | PERSIST_ON_TOUCH | Implement | [state-17-persist-on-touch.md](../patterns/bootstrap/state-17-persist-on-touch.md) |
| 18 | COMMIT_AND_PUSH | Implement | [state-18-commit-and-push.md](../patterns/bootstrap/state-18-commit-and-push.md) |

Begin at STATE 0. Read [state-0-branch-setup.md](../patterns/bootstrap/state-0-branch-setup.md) now.
