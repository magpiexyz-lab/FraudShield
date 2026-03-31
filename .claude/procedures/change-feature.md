# /change: Feature Implementation

> Invoked by change.md Step 6 when type is Feature.
> Read the full change skill at `.claude/commands/change.md` for lifecycle context.

## Prerequisites from change.md

- experiment.yaml and experiment/EVENTS.yaml have been read (Step 2)
- Change classified as Feature (Step 3)
- Preconditions checked (Step 4)
- Plan approved (Phase 1)
- Specs updated (Step 5)

## Implementation

- If `quality: production` is set in experiment.yaml:
  1. **ON-TOUCH check** (see `patterns/on-touch-check.md`): If `experiment/on-touch.yaml` exists: first, remove any entries whose `path` no longer exists on disk (stale from deleted modules). Then check if any files in the implementation plan are listed as ON-TOUCH. For each match: add a prerequisite TDD task to write specification tests for the existing code in that file BEFORE writing new feature code. Remove the entry from `experiment/on-touch.yaml` after tests are added. If `on_touch` list is now empty, delete `experiment/on-touch.yaml`.
  2. Generate implementation plan (see `procedures/tdd-task-generation.md`) — break into 2-5 min TDD tasks (exact files, spec test code, expected failure, minimal impl) per `patterns/tdd.md` § Task Granularity. Link each task to its behavior ID(s) from experiment.yaml. Include the behavior's `tests` array entries in the task description — the implementer must generate an `it()` assertion for each entry. Mark each task as **visual** (targets `.tsx` page or component files) or **logic** (everything else).
  3. Analyze task dependency graph per `patterns/tdd.md` § Task Dependency Ordering:
     - Independent tasks → spawn implementer agents in parallel (isolation: "worktree")
     - Dependent tasks (B imports A) → sequential execution per `patterns/tdd.md` § Sequential Execution Protocol (merge A's worktree, verify output on branch, then spawn B)
     - Tell user: "N tasks, M parallel / K sequential"
  4. For each task: spawn the appropriate agent (isolation: "worktree") based on task type:
     - **Logic tasks** → spawn implementer (`agents/implementer.md`)
     - **Visual tasks** (.tsx pages/components) → spawn visual-implementer (`agents/visual-implementer.md`) — this agent auto-loads frontend-design skill and applies design quality during the GREEN phase
     You MUST NOT implement any planned task directly — every task goes through an agent with the full RED→GREEN→REFACTOR cycle. No exceptions for "trivial," "wiring," or "already tested elsewhere."

> **Worktree isolation is mandatory.** Every `Agent(...)` call for implementer/visual-implementer
> MUST include `isolation: "worktree"`. Omitting this parameter is a process violation — Gate Keeper
> G4 will BLOCK verification if worktree merge evidence is absent from git history.
  5. **Check agent results.** After each agent completes, check its Status output:
     - `Status: complete` → proceed to merge
     - `Status: blocked: <reason>` → attempt recovery:
       a. If the block is a fixable environment issue (missing package, missing env var): fix on the current branch, then re-spawn the agent with the same task. Budget: 1 retry.
       b. If the block is a scope or spec issue (ambiguous task, conflicting requirements): revise the task description to clarify, then re-spawn. Budget: 1 retry.
       c. If still blocked after retry: skip the task, log it in the PR body under "Blocked tasks," and continue with remaining tasks. Do not attempt dependent tasks whose prerequisites were blocked.
  6. **Write implementer trace.** After each agent returns (before merge), write a trace based on the Output Contract. Use the agent type that was spawned (`implementer` or `visual-implementer`) for both the trace `agent` field and filename:
     ```bash
     python3 -c "
     import json, datetime, os
     os.makedirs('.claude/runs/agent-traces', exist_ok=True)
     agent_type = '<implementer|visual-implementer>'  # match the agent that was spawned
     trace = {'agent': f'{agent_type}-<task-slug>', 'status': '<complete|blocked>', 'timestamp': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'task': '<task description from Output Contract>', 'files_changed': [<Files Changed list from Output Contract>], 'tdd_cycle': '<red-green-refactor|skipped from Output Contract>', 'worktree_merged': False}
     if agent_type == 'visual-implementer':
         trace['design'] = '<DESIGN field from visual-implementer Output Contract>'
     json.dump(trace, open(f'.claude/runs/agent-traces/{agent_type}-<task-slug>.json', 'w'))
     "
     ```
     After merge, update the trace: set `worktree_merged: true`.
  7. **Merge worktree changes with verification.**
     For each completed implementer worktree:
     a. Verify the agent committed: run `git log --oneline main..<worktree-branch>` and confirm at least one commit beyond the fork point. If NO commit exists:
        - **Do NOT copy files manually or commit on behalf of the agent.**
        - Re-spawn the same implementer agent with a commit-only task: "Your prior implementation is complete but uncommitted. Stage and commit all changed files with `git add <files> && git commit -m 'Add <task-slug>'`. Then verify with `git log --oneline -1`." Budget: 1 retry.
        - If still no commit after retry, mark task as blocked in PR body.
     b. Merge: `git merge <worktree-branch> --no-ff -m "Merge implementer: <task-slug>"`. The `--no-ff` flag ensures a merge commit in git history (required for G4).
     c. If merge conflicts: resolve, then commit the merge resolution.
     d. Verify merge succeeded: `git log --oneline -1` must show the merge commit.
     e. Update the trace: set `worktree_merged: true`.

     If 2+ implementer agents were spawned: quick consistency scan — check for naming divergence, duplicate utilities (3+ copies per Rule 4), and mixed error handling patterns across modified files. Fix under green tests. Budget: 3 minutes. After scan, write result artifact:
     ```bash
     python3 -c "
     import json, datetime
     result = {'timestamp': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'), 'implementer_count': <N>, 'issues_found': <N>, 'issues_fixed': <N>, 'status': 'pass'}
     json.dump(result, open('.claude/runs/consistency-scan-result.json', 'w'))
     "
     ```
  8. Continue to Step 7
- If `quality` is absent or `mvp` (default):
- **MVP Task Breakdown** (Multi-layer features only — skip for Simple):
  Break the implementation into checkpointed steps. Each step ends with a `npm run build` gate.

  1. **Data layer** (if database changes needed):
     - Create migration file, TypeScript types, server-side DB helpers
     - Checkpoint: `npm run build` — types must compile

  2. **API layer** (if new routes needed):
     - Create API route handlers with zod validation
     - Wire to database helpers from step 1
     - Checkpoint: `npm run build` — routes must compile

  3. **UI/Output layer**:
     - web-app: Create page components, wire to API routes
     - service: Wire response formatting, add error responses
     - cli: Create command handlers, wire to lib functions
     - Checkpoint: `npm run build` — full app must compile

  4. **Analytics wiring**:
     - Add tracking calls per experiment/EVENTS.yaml
     - Checkpoint: `npm run build` — final verification

  Update `.claude/runs/current-plan.md` after each completed step:
  - Mark the step done in the plan body (prefix with `[x]`)
  - Keep `checkpoint: phase2-step6` in YAML frontmatter throughout Step 6 (resumption re-reads the plan body to determine which layers are done)
  - After all layers complete (including Analytics wiring): update checkpoint to `phase2-step7`

  For Simple (single-layer) features: implement directly without sub-steps — the existing implementation flow below provides sufficient structure.

  This task breakdown supersedes the Sub-step 6a/6b flow at the end of this file for Multi-layer features.

- If adding `payment` to experiment.yaml `stack`: verify both `stack.auth` and `stack.database` are also present. If `stack.auth` is missing, stop and tell the user: "Payment requires authentication to identify the paying user. Add `auth: supabase` (or another auth provider) to experiment.yaml `stack` first." If `stack.database` is missing, stop and tell the user: "Payment requires a database to record transaction state. Add `database: supabase` (or another database provider) to your experiment.yaml `stack` section."
- If the change requires a stack category whose library files don't exist yet (e.g., `payment: stripe` was just added to experiment.yaml but `src/lib/stripe.ts` is missing): install the packages listed in the stack file's "Packages" section, create the library files from its "Files to Create" section, and add its environment variables to `.env.example` — before proceeding to routes and pages. If any install command fails, stop and show the error — the user must fix the environment issue, then retry the failed install command on this branch (do NOT re-run `/change`).
- If `golden_path` was updated in Step 5 and `e2e/funnel.spec.ts` exists: update the funnel test to match the new golden_path. Read the new/modified page source for selectors. Do not rewrite unaffected test steps.
- If behaviors with `actor: system/cron` were updated in Step 5 and `tests/flows.test.ts` exists: add a new test case for the new system/cron behavior. Read the API route source for the endpoint path and expected behavior. If `tests/flows.test.ts` does not exist and vitest is not installed, install vitest and create the file with the new test case. Do not modify existing test cases.
- If the change touches auth or payment code (per CLAUDE.md Rule 4): verify `tests/flows.test.ts` has tests that go beyond auth guards for payment flows — assert handler logic (session creation, database state changes, webhook payload processing), not just 401/400 status codes. Add missing payment flow tests if absent.
- Wire analytics: every user action in the new feature must fire a tracked event. If archetype is `cli`: wrap all `trackServerEvent()` calls in the `isAnalyticsEnabled()` consent guard per the analytics stack file's CLI Opt-In Consent section — CLI telemetry must be opt-in.
- Create new pages following the framework stack file's file structure
- Every new page: follow page conventions from the framework stack file, import tracking functions per the analytics stack file, fire appropriate experiment/EVENTS.yaml events

> **STOP** — verify analytics before proceeding. Every new page must fire its events from experiment/EVENTS.yaml. Every user action in the new feature must have a tracking call. Do not proceed until confirmed. "I'll add analytics later" is not acceptable.

- Create or modify API routes for any new mutations (see framework stack file for route conventions). Every API route: validate input with zod, return proper HTTP status codes. If `stack.database` is present, use the server-side database client for data access.
- If database tables are needed: create a migration following the database stack file (next sequential number, `IF NOT EXISTS`), add TypeScript types, add post-merge instructions to PR body (CI auto-applies migrations on merge; otherwise `make migrate` or Supabase Dashboard). Note: concurrent branches may create conflicting migration numbers — resolve by renumbering the later-merged migration at merge time.
- **If Multi-layer** (fallback — only if the MVP Task Breakdown above was skipped, e.g., for Simple features that grew during implementation): implement in two sub-steps with an intermediate build check:
  - Sub-step 6a — Data and server layer (migrations, types, API routes)
  - Re-read `.claude/runs/current-plan.md` to confirm sub-step 6a output aligns with the approved plan.
  - Checkpoint: run `npm run build`. Fix errors before proceeding. If still broken after 2 attempts, proceed to Sub-step 6b without retrying — Step 7 (verification) has its own 3-attempt retry budget.
  - Sub-step 6b — Client/output layer (pages/endpoints/commands, components if applicable, analytics wiring)
