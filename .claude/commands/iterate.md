---
description: "Use when you have analytics data and want to decide what to do next. Analysis only — no code changes."
type: analysis-only
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - experiment/ads.yaml
stack_categories: [analytics]
requires_approval: false
references: []
branch_prefix: chore
modifies_specs: false
---
Review the experiment's progress and recommend what to do next.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | READ_CONTEXT | Plan | [state-0-read-context.md](../patterns/iterate/state-0-read-context.md) |
| 1 | GATHER_DATA | Plan | [state-1-gather-data.md](../patterns/iterate/state-1-gather-data.md) |
| 2 | COMPUTE_VERDICTS | Plan | [state-2-compute-verdicts.md](../patterns/iterate/state-2-compute-verdicts.md) |
| 3 | DECISION | Plan | [state-3-decision.md](../patterns/iterate/state-3-decision.md) |
| 4 | OUTPUT | Implement | [state-4-output.md](../patterns/iterate/state-4-output.md) |
| 5 | SKILL_EPILOGUE | Implement | [state-5-skill-epilogue.md](../patterns/iterate/state-5-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-read-context.md](../patterns/iterate/state-0-read-context.md) now.

## Do NOT
- Write code or modify source files — this skill is analysis only
- Recommend more than 3 actions — focus is more valuable than breadth
- Recommend actions outside the defined commands (bootstrap, change, iterate, retro, distribute, verify)
- Be vague — every recommendation must be specific enough to act on
- Ignore the data — don't recommend features if the funnel shows a landing page problem
- Recommend adding features when the real problem is distribution or positioning
