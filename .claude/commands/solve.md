---
description: "First-principles analysis to find the strongest solution. Use for architectural decisions, complex tradeoffs, and non-obvious problems."
type: analysis-only
reads: []
stack_categories: []
requires_approval: true
references:
  - .claude/patterns/solve-reasoning.md
branch_prefix: ""
modifies_specs: false
---
Find the optimal solution to a problem using first-principles analysis, structured research, constraint enumeration, self-critique, and convergence.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | INPUT_PARSE | Plan | [state-0-input-parse.md](../patterns/solve/state-0-input-parse.md) |
| 1 | EXECUTE | Implement | [state-1-execute.md](../patterns/solve/state-1-execute.md) |
| 2 | OUTPUT | Implement | [state-2-output.md](../patterns/solve/state-2-output.md) |
| 3 | SKILL_EPILOGUE | Implement | [state-3-skill-epilogue.md](../patterns/solve/state-3-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-input-parse.md](../patterns/solve/state-0-input-parse.md) now.
