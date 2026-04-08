---
description: "File a template observation manually. Use when you spot a template issue outside of automated observation."
type: analysis-only
reads: []
stack_categories: []
requires_approval: false
references:
  - .claude/patterns/observe.md
branch_prefix: ""
modifies_specs: false
---
Evaluate a template file and file an observation issue if it qualifies. $ARGUMENTS

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | INPUT_PARSE | Plan | [state-0-input-parse.md](../patterns/observe-cmd/state-0-input-parse.md) |
| 1 | EVALUATE_AND_FILE | Implement | [state-1-evaluate-and-file.md](../patterns/observe-cmd/state-1-evaluate-and-file.md) |
| 2 | SKILL_EPILOGUE | Implement | [state-2-skill-epilogue.md](../patterns/observe-cmd/state-2-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-input-parse.md](../patterns/observe-cmd/state-0-input-parse.md) now.

## Do NOT
- Modify any code files -- this skill is analysis only
- Create branches or PRs
- Change experiment.yaml or any spec file
- Install or remove packages
