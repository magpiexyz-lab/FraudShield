---
description: "Use at the end of an experiment or when the measurement window ends. Files structured feedback as a GitHub Issue."
type: analysis-only
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
stack_categories: []
requires_approval: false
references: []
branch_prefix: chore
modifies_specs: false
---
Run a structured retrospective for the current experiment and file it as a GitHub Issue.

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | READ_CONTEXT | Plan | [state-0-read-context.md](../patterns/retro/state-0-read-context.md) |
| 1 | INTERVIEW | Plan | [state-1-interview.md](../patterns/retro/state-1-interview.md) |
| 2 | GENERATE | Implement | [state-2-generate.md](../patterns/retro/state-2-generate.md) |
| 3 | FILE_ISSUE | Implement | [state-3-file-issue.md](../patterns/retro/state-3-file-issue.md) |
| 4 | SKILL_EPILOGUE | Implement | [state-4-skill-epilogue.md](../patterns/retro/state-4-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-read-context.md](../patterns/retro/state-0-read-context.md) now.

## Do NOT
- Modify any code files
- Create branches or PRs
- Change experiment.yaml, experiment/EVENTS.yaml, or any spec file
- Install or remove packages
