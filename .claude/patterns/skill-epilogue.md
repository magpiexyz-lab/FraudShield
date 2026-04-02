# Skill Epilogue — Unified Quality Assurance at Skill Termination

Follow this procedure at the end of every skill that does NOT embed `/verify`.
Two strategies, dispatched by evidence type:

## Applicability

| Strategy | Skills | When |
|----------|--------|------|
| **A — Code Observation** | `/resolve`, `/review`, `/deploy`, `/spec` | Skill produces diffs or modifies template files → spawn observer agent |
| **B — Execution Audit** | `/audit`, `/solve`, `/iterate`, `/retro`, `/rollback`, `/teardown` | Analysis-only, no diffs → inline friction check |

**Skip for:**
- Skills that embed `/verify` (`/bootstrap`, `/change`, `/harden`, `/distribute`) — verify.md STATE 6 handles observation
- `/optimize-prompt` — stateless utility, no state machine
- `/verify` itself — has its own STATE 6 + STATE 7

## Step 0: Verify state completion (both strategies)

Before proceeding with observation, check that the skill completed all required states.

Read `.runs/<skill>-context.json` and compare `completed_states` against
`_required_states` from `state-registry.json` `agent_gates[<skill>]`.

If any required state is missing:
- Record as friction in Step B2/Step 4 evaluation
- Note the missing state IDs for observe.md Path 2 evaluation
- Continue with Step 1 regardless (observation is best-effort)

If all required states are present or `_required_states` is not defined for this skill,
proceed to Step 1 with no friction recorded from this step.

## Step 1: Collect evidence (artifact-based, not memory-based)

```bash
# a. Collect all branch changes
# Committed changes if any, otherwise fall back to staged+unstaged
if git log --oneline $(git merge-base main HEAD)..HEAD 2>/dev/null | grep -q .; then
  git diff $(git merge-base main HEAD)...HEAD > .runs/observer-diffs.txt
else
  git diff --cached > .runs/observer-diffs.txt
  git diff >> .runs/observer-diffs.txt
fi

# b. Read fix-log (if exists)
# .runs/fix-log.md — created during skill execution when retries/failures occur

# c. Generate template file list
find .claude/stacks .claude/commands .claude/patterns scripts -type f 2>/dev/null | sort
# Plus: Makefile, CLAUDE.md
```

## Step 2: Write epilogue context

Write `.runs/epilogue-context.json`:
```json
{
  "skill": "<skill-name>",
  "mode": "epilogue",
  "timestamp": "<ISO 8601>",
  "branch": "<current branch>"
}
```

This file signals to `agent-state-gate.sh` that the observer is being
spawned from a skill epilogue (not from verify.md), enabling the relaxed
prerequisite path.

## Step 3: Fast-path evaluation

If `.runs/observer-diffs.txt` is empty AND `.runs/fix-log.md` has no entries
(or does not exist):

Write `.runs/observe-result.json`:
```json
{
  "skill": "<skill-name>",
  "timestamp": "<ISO 8601>",
  "friction_detected": false,
  "observations_filed": 0,
  "verdict": "clean"
}
```

**DONE.** Zero overhead on the happy path. The commit gate
(`observe-commit-gate.sh`) is satisfied.

## Step 4: Spawn observer

If evidence exists (non-empty diff or fix-log entries):

1. Prepare observer inputs:
   - Content of `.runs/observer-diffs.txt`
   - Content of `.runs/fix-log.md` (or "no fix-log entries")
   - Template file list from Step 1c
   - Skill name

2. Spawn the `observer` agent (`subagent_type: observer`).
   Pass ONLY the inputs above — do NOT include experiment.yaml content,
   project name, or feature descriptions.
   The observer follows `.claude/patterns/observe.md` Path 1 criteria.

3. After observer returns, write `.runs/observe-result.json`:
   ```json
   {
     "skill": "<skill-name>",
     "timestamp": "<ISO 8601>",
     "friction_detected": true,
     "observations_filed": <N>,
     "verdict": "filed" | "no-template-issues"
   }
   ```
   - `"filed"` — observer created or commented on GitHub issues
   - `"no-template-issues"` — observer evaluated but found no template-rooted issues

4. If observer spawning fails for any reason, write observe-result.json with
   `"verdict": "no-template-issues"` and continue. Observation is best-effort.

## Strategy B: Execution Audit

For analysis-only skills (`/audit`, `/solve`, `/iterate`, `/retro`, `/rollback`, `/teardown`).
These skills have no diffs to observe, so the observer agent is never spawned.

### Step B1: Verify execution completeness

Read `.runs/<skill>-context.json` and verify that `completed_states` includes
all expected states from `state-registry.json` for this skill (excluding the
epilogue state itself). If any expected state is missing, record it as friction.

### Step B2: Check for friction

Scan the execution for signs of template-caused friction:
- Did any state require retries or error recovery?
- Did the skill produce partial or unexpected results?
- Were any template files (`.claude/patterns/`, `.claude/stacks/`, `.claude/commands/`,
  `scripts/`) read during execution and found to be ambiguous, incomplete, or contradictory?

If no friction detected, skip to Step B4.

### Step B3: Evaluate template root cause (Path 2)

If friction was detected in Step B2, evaluate inline against observe.md Path 2 criteria:
- **Condition A:** Is a template file the root cause? (not user code, not experiment config)
- **Condition B:** Is it NOT an environment issue? (not missing CLI, not network)
- **Condition C:** Is it NOT specific to this project? ("Would another developer with a
  different experiment.yaml hit this same problem?")

If all three conditions are true, follow observe.md's Redaction, Dedup, and Issue Creation
sections directly. Do NOT spawn a separate agent — evaluate inline.

### Step B4: Write result

Write `.runs/observe-result.json`:
```json
{
  "skill": "<skill-name>",
  "timestamp": "<ISO 8601>",
  "strategy": "execution-audit",
  "friction_detected": true | false,
  "observations_filed": 0,
  "verdict": "clean" | "filed" | "no-template-issues"
}
```
- `"clean"` — no friction detected
- `"filed"` — observation issue created on template repo
- `"no-template-issues"` — friction existed but did not trace to a template file

## Constraints

- **Best-effort.** Any failure in the epilogue → write observe-result.json with
  `"verdict": "clean"` and continue. Never block the skill.
- **Max 1 observer spawn per epilogue.** Combine all evidence into a single evaluation.
  Strategy B never spawns a subagent.
- **No project-specific data in observer prompt.** Follow observe.md redaction rules.
