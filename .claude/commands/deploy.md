---
description: "Deploy or update the app. Run after /bootstrap PR is merged; re-run to update."
type: analysis-only
reads:
  - experiment/experiment.yaml
  - .env.example
  - CLAUDE.md
  - experiment/EVENTS.yaml
stack_categories: [hosting, database, auth, analytics, payment, email]
requires_approval: true
references:
  - .claude/patterns/observe.md
branch_prefix: ""
modifies_specs: false
---
Deploy the app to production by creating cloud infrastructure and deploying via CLI.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | PRE_FLIGHT | Plan | [state-0-pre-flight.md](../patterns/deploy/state-0-pre-flight.md) |
| 1 | CONFIG_GATHER | Plan | [state-1-config-gather.md](../patterns/deploy/state-1-config-gather.md) |
| 2 | USER_APPROVAL | Plan | [state-2-user-approval.md](../patterns/deploy/state-2-user-approval.md) |
| 3 | PROVISION | Implement | [state-3-provision.md](../patterns/deploy/state-3-provision.md) |
| 4 | HEALTH_CHECK | Implement | [state-4-health-check.md](../patterns/deploy/state-4-health-check.md) |
| 5 | MANIFEST_WRITE | Implement | [state-5-manifest-write.md](../patterns/deploy/state-5-manifest-write.md) |
| 6 | SKILL_EPILOGUE | Implement | [state-6-skill-epilogue.md](../patterns/deploy/state-6-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-pre-flight.md](../patterns/deploy/state-0-pre-flight.md) now.

## Do NOT

- Create a git branch or PR — this is infrastructure-only
- Modify any source code files
- Store secrets in code or commit them
- Skip the approval step — the user must review the plan before resources are created
- Proceed if CLI auth checks fail — always stop and tell the user which login command to run
