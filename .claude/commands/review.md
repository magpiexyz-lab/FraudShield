---
description: "Automated review-fix loop: find issues, fix them, validate, repeat until clean."
type: code-writing
reads:
  - CLAUDE.md
  - experiment/EVENTS.yaml
  - scripts/check-inventory.md
  - experiment/experiment.example.yaml
stack_categories: []
requires_approval: false
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
branch_prefix: chore
modifies_specs: false
---
Run an automated review of the experiment template, fix findings, and validate
until clean. Replaces the manual workflow of running `scripts/scoped-review-prompt.md`.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | READ_CONTEXT | Setup | [state-0-read-context.md](../patterns/review/state-0-read-context.md) |
| 1 | BASELINE_VALIDATORS | Setup | [state-1-baseline-validators.md](../patterns/review/state-1-baseline-validators.md) |
| 2a | REVIEW_SCAN | Loop | [state-2a-review-scan.md](../patterns/review/state-2a-review-scan.md) |
| 2b | FILTER_FINDINGS | Loop | [state-2b-filter-findings.md](../patterns/review/state-2b-filter-findings.md) |
| 2c | ADVERSARIAL_VALIDATION | Loop | [state-2c-adversarial-validation.md](../patterns/review/state-2c-adversarial-validation.md) |
| 2d | BRANCH_SETUP | Loop | [state-2d-branch-setup.md](../patterns/review/state-2d-branch-setup.md) |
| 2e | FIX_FINDINGS | Loop | [state-2e-fix-findings.md](../patterns/review/state-2e-fix-findings.md) |
| 2f | LOOP_GATE | Loop | [state-2f-loop-gate.md](../patterns/review/state-2f-loop-gate.md) |
| 3 | UPDATE_INVENTORY | Finalize | [state-3-update-inventory.md](../patterns/review/state-3-update-inventory.md) |
| 4 | FINAL_VALIDATION | Finalize | [state-4-final-validation.md](../patterns/review/state-4-final-validation.md) |
| 5 | SKILL_EPILOGUE | Finalize | [state-5-skill-epilogue.md](../patterns/review/state-5-skill-epilogue.md) |
| 6 | COMMIT_PR | Finalize | [state-6-commit-pr.md](../patterns/review/state-6-commit-pr.md) |

## Loop Dispatch

States 2a through 2f form a review-fix loop. Run **2 to `max_iterations`** iterations:

1. Initialize: `seen_findings` = empty, `iteration` = 1, `yield_history` = empty
2. Execute states 2a → 2b → 2c → 2d → 2e → 2f in sequence
3. STATE 2f evaluates the loop gate — if continuing, go back to 2a; if terminating, proceed to STATE 3

Within-iteration early exits:
- STATE 2b produces 0 remaining findings → exit loop to STATE 3
- STATE 2e: no fixes succeeded → exit loop to STATE 3

Begin at STATE 0. Read [state-0-read-context.md](../patterns/review/state-0-read-context.md) now.

## Do NOT

- Modify experiment.yaml or experiment/EVENTS.yaml
- Enter plan mode or wait for user approval
- Add new features or pages
- Propose checks that regex-match natural-language prose
- Fix findings that overlap with check-inventory.md
- Run more than `max_iterations` iterations
- Exit before completing iteration 2 (minimum 2 required)
- Skip running validators after each fix
- Commit fixes that cause validator regressions
- Install or remove packages
- Commit to main directly
