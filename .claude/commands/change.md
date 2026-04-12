---
description: "Use for any modification to an existing bootstrapped app: new features, bug fixes, UI polish, analytics fixes, or adding tests."
type: code-writing
reads:
  - experiment/experiment.yaml
  - experiment/EVENTS.yaml
  - CLAUDE.md
stack_categories: [framework, database, auth, analytics, ui, payment, email, testing, hosting]
requires_approval: true
references:
  - .claude/patterns/verify.md
  - .claude/patterns/branch.md
  - .claude/patterns/observe.md
  - .claude/patterns/messaging.md
  - .claude/patterns/design.md
  - .claude/patterns/solve-reasoning.md
  - .claude/procedures/plan-exploration.md
  - .claude/procedures/plan-validation.md
  - .claude/procedures/change-plans.md
branch_prefix: change
modifies_specs: true
---
Make a change to the existing app: $ARGUMENTS

## Arguments

Parse `$ARGUMENTS` for:
- `#<number>` or bare number: read the GitHub issue via `gh issue view <number>` as the change description
- `--light`: force light solve-reasoning depth (skip deep analysis)
- `--full`: force full solve-reasoning depth (deep analysis regardless of complexity)
- Everything else: the change description in natural language

ARGUMENTS: $ARGUMENTS

## Mode Detection

Before entering the lifecycle, check `.runs/current-plan.md`:

- If it exists with frontmatter `skill: change` and a `checkpoint` field → **resume** mode. The lifecycle engine skips already-completed states automatically. State the detected checkpoint: "Resuming at **[checkpoint]**."
- If it does not exist → **fresh** mode.

## Lifecycle

1. Run `bash .claude/scripts/lifecycle-init.sh change '{"skill":"change"}'`
2. State execution loop:
   a. Run: `NEXT=$(bash .claude/scripts/lifecycle-next.sh change)`
   b. If NEXT is "FINALIZE" → go to step 3
   c. If NEXT does not start with "/" → STOP with error (print NEXT for diagnosis)
   d. Read the state file at $NEXT and execute its ACTIONS section
   e. After ACTIONS complete, run the state's STATE TRACKING command
      (the `bash .claude/scripts/advance-state.sh` call in the state file)
   f. Return to step 2a
3. Run `bash .claude/scripts/lifecycle-finalize.sh change`

**Note:** STATE 7 (USER_APPROVAL) pauses for user input. The lifecycle loop resumes when the user responds with approval.

## Do NOT
- Add more than what `$ARGUMENTS` describes — one change per PR
- Modify existing behaviors unless the change requires integration (e.g., adding a nav link)
- Remove or break existing analytics events (unless the change is specifically about fixing analytics)
- Add libraries not in experiment.yaml `stack` without user approval
- Skip updating experiment.yaml when adding new behaviors — the source of truth must always reflect the current app
- Change analytics event names — they must match experiment/EVENTS.yaml
- Add analytics events without user approval
- Add error-state tests — funnel happy path only (Rule 4)
- Mock services in tests — the whole point is testing real integrations
- Skip Step 7 verification (verify.md must run with the classified scope — build loop and auto-observe always run; review agents run per scope)
- Commit to main directly
