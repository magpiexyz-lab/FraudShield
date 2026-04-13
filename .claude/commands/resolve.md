---
description: "Resolve GitHub issues filed against the template: triage, diagnose via first-principles analysis, fix, and validate."
type: code-writing
reads:
  - CLAUDE.md
  - scripts/check-inventory.md
stack_categories: []
requires_approval: true
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
  - .claude/patterns/skill-epilogue.md
  - .claude/patterns/solve-reasoning.md
branch_prefix: fix
modifies_specs: false
---
Resolve GitHub issues or refine template quality: $ARGUMENTS

## Modes
- `/resolve #42` — resolve a specific issue
- `/resolve open issues` — resolve all open issues
- `/resolve --refine` — analyze team traces + observation issues to improve template quality

ARGUMENTS: $ARGUMENTS

## Lifecycle

1. Enter worktree isolation:
   a. Call `EnterWorktree` with name `"resolve-<current-timestamp>"`
   b. If it succeeds: run `mkdir -p .runs`
   c. If it fails: continue in current directory (no worktree)
2. Run `bash .claude/scripts/lifecycle-init.sh resolve`
3. State execution loop:
   a. Run: `NEXT=$(bash .claude/scripts/lifecycle-next.sh resolve)`
   b. If NEXT is "FINALIZE" → go to step 4
   c. If NEXT does not start with "/" → STOP with error (print NEXT for diagnosis)
   d. Read the state file at $NEXT and execute its ACTIONS section
   e. After ACTIONS complete, run the state's STATE TRACKING command
      (the `bash .claude/scripts/advance-state.sh` call in the state file)
   f. Return to step 3a
4. Run `bash .claude/scripts/lifecycle-finalize.sh resolve`
5. Read `.claude/patterns/finalize-epilogue.md` and execute
6. If worktree was entered in step 1:
   a. Run `bash .claude/scripts/lifecycle-worktree-sync.sh`
   b. Call `ExitWorktree` with action `"remove"`

## Do NOT

- Modify experiment.yaml or other spec files
- Add new features or pages (exception: creating permanent external stack files in STATE 9a is a recurrence-prevention fix)
- Fix things not described in the issues
- Install or remove packages
- Commit to main directly
- Skip validator runs after fixes
- Commit fixes that cause validator regressions
- Apply band-aid fixes that don't address root cause
- Fix only the reported instance when blast radius shows more
