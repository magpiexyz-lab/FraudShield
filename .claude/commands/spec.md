---
description: "Transform an idea into a complete Level 3 experiment.yaml with hypotheses, behaviors, variants, and stack."
type: code-writing
writes: [experiment/EVENTS.yaml]
stack_categories: []
requires_approval: true
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
  - .claude/patterns/spec-reasoning.md
branch_prefix: feat
modifies_specs: true
---
Transform an idea into a complete experiment specification: $ARGUMENTS

## JIT State Dispatch

Read each STATE's file **only when transitioning to that state**. Do NOT read ahead. Complete the VERIFY check before reading the next state. This ensures you hold only one state's instructions in working memory at a time.

| STATE | Name | Phase | File |
|-------|------|-------|------|
| 0 | INPUT_PARSE | Plan | [state-0-input-parse.md](../patterns/spec/state-0-input-parse.md) |
| 1 | RESEARCH | Plan | [state-1-research.md](../patterns/spec/state-1-research.md) |
| 2 | HYPOTHESES | Plan | [state-2-hypotheses.md](../patterns/spec/state-2-hypotheses.md) |
| 3 | BEHAVIORS | Plan | [state-3-behaviors.md](../patterns/spec/state-3-behaviors.md) |
| 4 | GOLDEN_PATH | Plan | [state-4-golden-path.md](../patterns/spec/state-4-golden-path.md) |
| 5 | VARIANTS | Plan | [state-5-variants.md](../patterns/spec/state-5-variants.md) |
| 6 | STACK_FUNNEL | Plan | [state-6-stack-funnel.md](../patterns/spec/state-6-stack-funnel.md) |
| 7 | OUTPUT | Implement | [state-7-output.md](../patterns/spec/state-7-output.md) |
| 8 | SKILL_EPILOGUE | Implement | [state-8-skill-epilogue.md](../patterns/spec/state-8-skill-epilogue.md) |

Begin at STATE 0. Read [state-0-input-parse.md](../patterns/spec/state-0-input-parse.md) now.

## Do NOT
- Add behaviors not traceable to a hypothesis
- Add stack components not required by Level 3
- Generate fewer than 3 variants or fewer than 5 pending hypotheses
- Produce hypotheses without a `metric` object containing `formula`, numeric `threshold`, and `operator`
- Modify any file other than `experiment/experiment.yaml`, `experiment/EVENTS.yaml`, `.runs/spec-manifest.json`, and `.runs/verify-history.jsonl`
- Skip the user approval checkpoint in Step 6
- Proceed past any STOP point without explicit user confirmation
- Skip auth or database — Level 3 always includes them
- Skip payment stack when monetize hypotheses are present
