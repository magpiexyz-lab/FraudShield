---
description: "Tear down cloud infrastructure created by /deploy. Use when ending an experiment."
type: analysis-only
reads:
  - experiment/experiment.yaml
  - .claude/deploy-manifest.json
  - CLAUDE.md
stack_categories: [hosting, database, analytics, payment]
requires_approval: true
references: []
branch_prefix: ""
modifies_specs: false
---
Tear down the cloud infrastructure created by `/deploy`.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | PRE_FLIGHT | Plan | [state-0-pre-flight.md](../patterns/teardown/state-0-pre-flight.md) |
| 1 | USER_CONFIRMATION | Plan | [state-1-user-confirmation.md](../patterns/teardown/state-1-user-confirmation.md) |
| 2 | DESTROY_RESOURCES | Implement | [state-2-destroy-resources.md](../patterns/teardown/state-2-destroy-resources.md) |
| 3 | VERIFY_DELETION | Implement | [state-3-verify-deletion.md](../patterns/teardown/state-3-verify-deletion.md) |
| 4 | CLEANUP | Implement | [state-4-cleanup.md](../patterns/teardown/state-4-cleanup.md) |
| 5 | SKILL_EPILOGUE | Implement | [state-5-skill-epilogue.md](../patterns/teardown/state-5-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-pre-flight.md](../patterns/teardown/state-0-pre-flight.md) now.

## Do NOT

- Delete source code, experiment.yaml, or git history
- Delete without user confirmation (name + data check)
- Block on partial failures — report and continue
- Delete .env.example (that's a template, not credentials)
