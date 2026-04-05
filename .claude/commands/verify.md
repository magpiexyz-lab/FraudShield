---
description: "Unified verification: build, agent review, E2E tests. Run after /bootstrap or /change. Also works standalone as a quality gate."
type: code-writing
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
stack_categories: [testing, framework, analytics]
requires_approval: false
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
branch_prefix: fix
modifies_specs: false
---
Unified verification: build, agent review, E2E tests, and (in bootstrap-verify mode) PR creation.

## Mode Detection

Before entering the state machine, detect the operating mode by checking `.runs/current-plan.md`:

- If it exists with frontmatter `skill: bootstrap` and `checkpoint: awaiting-verify` → **bootstrap-verify** mode
- If it exists with frontmatter `skill: change` → **change-verify** mode
- If it does not exist → **standalone** mode

State the detected mode: "Running in **[mode]** mode."

Shared algorithms (Exhaustion Protocol, Agent Efficiency Directives, Build & Lint Loop) are in `.claude/patterns/verify.md`.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | READ_CONTEXT | Setup | [state-0-read-context.md](../patterns/verify/state-0-read-context.md) |
| 1 | BUILD_LINT_LOOP | Verify | [state-1-build-lint-loop.md](../patterns/verify/state-1-build-lint-loop.md) |
| 2 | PHASE1_PARALLEL | Verify | [state-2-phase1-parallel.md](../patterns/verify/state-2-phase1-parallel.md) |
| 3a | DESIGN_AGENTS | Verify | [state-3a-design-agents.md](../patterns/verify/state-3a-design-agents.md) |
| 3b | QUALITY_GATE | Verify | [state-3b-quality-gate.md](../patterns/verify/state-3b-quality-gate.md) |
| 3c | UX_MERGE | Verify | [state-3c-ux-merge.md](../patterns/verify/state-3c-ux-merge.md) |
| 4 | SECURITY_MERGE_FIX | Verify | [state-4-security-merge-fix.md](../patterns/verify/state-4-security-merge-fix.md) |
| 5 | E2E_TESTS | Verify | [state-5-e2e-tests.md](../patterns/verify/state-5-e2e-tests.md) |
| 6 | AUTO_OBSERVE | Finalize | [state-6-auto-observe.md](../patterns/verify/state-6-auto-observe.md) |
| 7a | WRITE_REPORT | Finalize | [state-7a-write-report.md](../patterns/verify/state-7a-write-report.md) |
| 7b | COMPUTE_QSCORE | Finalize | [state-7b-compute-qscore.md](../patterns/verify/state-7b-compute-qscore.md) |
| 8 | SAVE_PATTERNS | Finalize | [state-8-save-patterns.md](../patterns/verify/state-8-save-patterns.md) |

Begin at STATE 0. Read [state-0-read-context.md](../patterns/verify/state-0-read-context.md) now.

## Do NOT
- Modify experiment.yaml or experiment/EVENTS.yaml
- Add new features — only fix what tests and agents expose
- Run tests against production (always use local dev server)
- Skip the build verification step
- Skip agent review steps required by the scope
- Commit to main directly
- Create a PR in change-verify mode (that's /change's job)
