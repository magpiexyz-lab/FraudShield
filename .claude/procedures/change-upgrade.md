# /change: Upgrade Implementation

> Invoked by change.md Step 6 when type is Upgrade.
> Read the full change skill at `.claude/commands/change.md` for lifecycle context.

## Prerequisites from change.md

- experiment.yaml and experiment/EVENTS.yaml have been read (Step 2)
- Change classified as Upgrade (Step 3)
- Preconditions checked (Step 4)
- Plan approved (Phase 1)
- Specs updated (Step 5)

## Implementation

- Unless `quality: mvp` is set in experiment.yaml:
  1. **ON-TOUCH check** (see `patterns/on-touch-check.md`): If `experiment/on-touch.yaml` exists: first, remove any entries whose `path` no longer exists on disk (stale from deleted modules). Then check if any files in the upgrade plan are listed as ON-TOUCH. For each match: add a prerequisite TDD task to write specification tests for the existing code in that file BEFORE writing upgrade code. Remove the entry from `experiment/on-touch.yaml` after tests are added. If `on_touch` list is now empty, delete `experiment/on-touch.yaml`.
  2. Generate TDD tasks for the integration per `patterns/tdd.md`. Link each task to its behavior ID(s) from experiment.yaml and include the behavior's `tests` array entries — the implementer must generate an `it()` assertion for each entry. Tasks should cover:
     - Credential storage/retrieval
     - Webhook signature validation (if applicable)
     - Error recovery (timeout, rate limit, invalid response)
     - Happy path end-to-end
  3. Spawn implementer agents (same procedure as Feature production path, including step 6 trace writing)
  4. **Merge worktree changes with verification** (same procedure as `change-feature.md` step 7, substeps a-e). For each implementer worktree:
     - Verify implementer committed (`git log --oneline main..<worktree-branch>`)
     - If no commit: re-spawn agent for commit-only (do NOT commit on behalf of the agent). Budget: 1 retry.
     - Merge: `git merge <worktree-branch> --no-ff -m "Merge implementer: <task-slug>"`
     - Verify merge commit, update trace `worktree_merged: true`
     If 2+ agents: run consistency scan (3 min budget).
  5. Continue to Step 7
- If `quality: mvp` is set:
- Read or generate the external stack file for the service (`.claude/stacks/external/<service-slug>.md`) — use the same generation procedure as described in `.claude/procedures/scaffold-externals.md` (Step 6)
- Replace the Fake Door component with real UI that calls the actual API route
- Replace any stub route (501/503) with the full integration logic using the service's API
- Remove `fake_door: true` from the `activate` event call — keep the same event name (`activate`) and `action` value for analytics continuity
- Add the service's env vars to `.env.example`
- Ask the user for credential values and add to `.env.local`
- Verify the end-to-end user flow after the upgrade: UI → API route → external service
