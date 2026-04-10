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

## Lifecycle

1. Run `bash .claude/scripts/lifecycle-init.sh solve`
2. State execution loop:
   a. Run: `NEXT=$(bash .claude/scripts/lifecycle-next.sh solve)`
   b. If NEXT is "FINALIZE" → go to step 3
   c. If NEXT does not start with "/" → STOP with error (print NEXT for diagnosis)
   d. Read the state file at $NEXT and execute its ACTIONS section
   e. After ACTIONS complete, run the state's STATE TRACKING command
      (the `bash .claude/scripts/advance-state.sh` call in the state file)
   f. Return to step 2a
3. Run `bash .claude/scripts/lifecycle-finalize.sh solve`
