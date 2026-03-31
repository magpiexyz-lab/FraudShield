---
description: "Roll back to the previous production deployment. Emergency use — no branch or PR."
type: analysis-only
requires_approval: true
branch_prefix: ""
reads:
  - .claude/runs/deploy-manifest.json
  - experiment/experiment.yaml
stack_categories:
  - hosting
references:
  - .claude/patterns/incident-response.md
modifies_specs: false
---
Roll back to the previous production deployment when something goes wrong after deploy.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | READ_CONTEXT | Plan | [state-0-read-context.md](../patterns/rollback/state-0-read-context.md) |
| 1 | PLAN | Plan | [state-1-plan.md](../patterns/rollback/state-1-plan.md) |
| 2 | USER_APPROVAL | Plan | [state-2-user-approval.md](../patterns/rollback/state-2-user-approval.md) |
| 3 | EXECUTE | Implement | [state-3-execute.md](../patterns/rollback/state-3-execute.md) |
| 4 | SKILL_EPILOGUE | Implement | [state-4-skill-epilogue.md](../patterns/rollback/state-4-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-read-context.md](../patterns/rollback/state-0-read-context.md) now.
