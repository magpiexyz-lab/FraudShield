---
description: "Analyze template structural quality: duplication, complexity, abstractability, skill architecture. Analysis only — no code changes."
type: analysis-only
reads:
  - CLAUDE.md
  - scripts/check-inventory.md
stack_categories: []
requires_approval: false
references: []
branch_prefix: ""
modifies_specs: false
---
Audit the template's structural quality. $ARGUMENTS

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | SCOPE_AND_BASELINE | Plan | [state-0-scope-and-baseline.md](../patterns/audit/state-0-scope-and-baseline.md) |
| 1 | PARALLEL_ANALYSIS | Implement | [state-1-parallel-analysis.md](../patterns/audit/state-1-parallel-analysis.md) |
| 2 | PRIORITIZE_AND_OUTPUT | Implement | [state-2-prioritize-and-output.md](../patterns/audit/state-2-prioritize-and-output.md) |
| 3 | SKILL_EPILOGUE | Implement | [state-3-skill-epilogue.md](../patterns/audit/state-3-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-scope-and-baseline.md](../patterns/audit/state-0-scope-and-baseline.md) now.

## Do NOT
- Modify any source files — this skill is analysis only
- Create branches or PRs
- Propose fixes for correctness issues — that is `/review`'s job
- Flag intentional JIT repetition as duplication
- Report "long but simple" files as complexity hotspots
- Report the same finding under both Dimension A and Dimension C
- Report D2 findings for cross-skill patterns — that is Dimension C's scope
- Report D1 findings for file-level complexity — that is Dimension B's scope
