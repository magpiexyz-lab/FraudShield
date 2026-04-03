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

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | FETCH_ISSUES | Triage | [state-0-fetch-issues.md](../patterns/resolve/state-0-fetch-issues.md) |
| 1 | READ_CONTEXT | Triage | [state-1-read-context.md](../patterns/resolve/state-1-read-context.md) |
| 2 | TRIAGE | Triage | [state-2-triage.md](../patterns/resolve/state-2-triage.md) |
| 3 | REPRODUCE | Diagnose | [state-3-reproduce.md](../patterns/resolve/state-3-reproduce.md) |
| 4 | BLAST_RADIUS | Diagnose | [state-4-blast-radius.md](../patterns/resolve/state-4-blast-radius.md) |
| 4b | ROOT_CAUSE_CLUSTERING | Diagnose | [state-4b-root-cause-clustering.md](../patterns/resolve/state-4b-root-cause-clustering.md) |
| 5 | FIX_DESIGN | Diagnose | [state-5-fix-design.md](../patterns/resolve/state-5-fix-design.md) |
| 5d | ADVERSARIAL_CHALLENGE | Diagnose | [state-5d-adversarial-challenge.md](../patterns/resolve/state-5d-adversarial-challenge.md) |
| 6 | BRANCH_SETUP | Fix | [state-6-branch-setup.md](../patterns/resolve/state-6-branch-setup.md) |
| 7 | IMPLEMENT_FIXES | Fix | [state-7-implement-fixes.md](../patterns/resolve/state-7-implement-fixes.md) |
| 8 | FINAL_VALIDATION | Fix | [state-8-final-validation.md](../patterns/resolve/state-8-final-validation.md) |
| 8b | SIDE_EFFECT_SCAN | Fix | [state-8b-side-effect-scan.md](../patterns/resolve/state-8b-side-effect-scan.md) |
| 9 | SAVE_PATTERNS | Fix | [state-9-save-patterns.md](../patterns/resolve/state-9-save-patterns.md) |
| 10 | SKILL_EPILOGUE | Fix | [state-10-skill-epilogue.md](../patterns/resolve/state-10-skill-epilogue.md) |
| 11 | COMMIT_PR | Fix | [state-11-commit-pr.md](../patterns/resolve/state-11-commit-pr.md) |

Begin at STATE 0. Read [state-0-fetch-issues.md](../patterns/resolve/state-0-fetch-issues.md) now.

## Do NOT

- Modify experiment.yaml or other spec files
- Add new features or pages
- Fix things not described in the issues
- Install or remove packages
- Commit to main directly
- Skip validator runs after fixes
- Commit fixes that cause validator regressions
- Apply band-aid fixes that don't address root cause
- Fix only the reported instance when blast radius shows more
