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

1. Enter worktree isolation:
   a. Call `EnterWorktree` with name `"solve-<current-timestamp>"`
   b. If it succeeds: run `mkdir -p .runs`
   c. If it fails: continue in current directory (no worktree)
2. Run `bash .claude/scripts/lifecycle-init.sh solve`
3. State execution loop:
   a. Run: `NEXT=$(bash .claude/scripts/lifecycle-next.sh solve)`
   b. If NEXT is "FINALIZE" → go to step 4
   c. If NEXT does not start with "/" → STOP with error (print NEXT for diagnosis)
   d. Read the state file at $NEXT and execute its ACTIONS section
   e. After ACTIONS complete, run the state's STATE TRACKING command
      (the `bash .claude/scripts/advance-state.sh` call in the state file)
   f. Return to step 3a
4. Run `bash .claude/scripts/lifecycle-finalize.sh solve`
5. Read `.claude/patterns/finalize-epilogue.md` and execute
6. If worktree was entered in step 1:
   a. Run `bash .claude/scripts/lifecycle-worktree-sync.sh`
   b. Call `ExitWorktree` with action `"remove"`

## Do NOT
- Modify any source files — this skill is analysis only
- Create branches or PRs
- Change experiment.yaml or any spec file
- Install or remove packages
- Implement the solution — that is `/change` or `/resolve`'s job
- Propose solutions that require libraries not in experiment.yaml `stack`
