# Skill Epilogue — Unified Quality Assurance at Skill Termination

Follow this procedure at the end of every skill that does NOT embed `/verify`.
Two strategies, dispatched by evidence type:

## Applicability

| Strategy | Skills | When |
|----------|--------|------|
| **A — Code Observation** | `/resolve`, `/review`, `/deploy`, `/spec`, `/upgrade` | Skill produces diffs or modifies template files → spawn observer agent |
| **B — Execution Audit** | `/audit`, `/solve`, `/iterate`, `/retro`, `/rollback`, `/teardown` | Analysis-only, no diffs → inline friction check |

**Skip for:**
- Skills that embed `/verify` (`/bootstrap`, `/change`, `/distribute`) — verify.md STATE 6 handles observation
- `/optimize-prompt` — stateless utility, no state machine
- `/verify` itself — has its own STATE 6 + STATE 7

## Step 0: Verify state completion (both strategies)

Before proceeding with observation, check that the skill completed all required states.

Read `.runs/<skill>-context.json` and compare `completed_states` against
`_required_states` from `state-registry.json` `agent_gates[<skill>]`.

If any required state is missing:
- **HARD FAIL**: The skill cannot produce `verdict: "clean"`. Set a flag
  `_incomplete_states = true` with the missing state IDs.
- The final `observe-result.json` MUST have `verdict: "incomplete"` — this
  overrides any other verdict determination in Steps 3-4 / B3-B4.
- Continue with remaining epilogue steps for compliance auditing, but the
  verdict is locked to "incomplete".

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

# c. Generate template file list (canonical source: .claude/template-owned-dirs.txt)
cat .claude/template-owned-dirs.txt | xargs find -type f 2>/dev/null | sort
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

## Step 3.5: Compliance Audit (Layer 2 — shared with Strategy B)

Run cross-artifact consistency checks (same as Step B2.5):
```bash
SKILL=$(python3 -c "import json;d=[json.load(open(f)) for f in __import__('glob').glob('.runs/*-context.json') if 'epilogue' not in f and 'verify' not in f];print(d[0]['skill'] if d else 'unknown')" 2>/dev/null)
RUN_ID=$(python3 -c "import json;d=[json.load(open(f)) for f in __import__('glob').glob('.runs/*-context.json') if 'epilogue' not in f and 'verify' not in f];print(d[0].get('run_id','') if d else '')" 2>/dev/null)
python3 .claude/scripts/compliance-audit.py --skill "$SKILL" --run-id "$RUN_ID"
```

Read `.runs/compliance-audit-result.json`. If `anomaly_count > 0`, pass anomalies
as additional context to the observer agent in Step 4.

The adaptive LLM audit decision (Step B2.6) also applies here — run `audit-sample.py`
and if triggered, include inline LLM evaluation of anomalies before spawning observer.

## Step 4: Spawn observer

> REF: The observer agent implements `.claude/patterns/observe.md` Path 1
> (Observer Agent with diff). The decision framework, redaction rules, dedup
> logic, and issue filing format are defined there.

If evidence exists (non-empty diff or fix-log entries):

1. Prepare observer inputs:
   - Content of `.runs/observer-diffs.txt`
   - Content of `.runs/fix-log.md` (or "no fix-log entries")
   - Template file list from Step 1c
   - Skill name

2. Spawn the `observer` agent (`subagent_type: observer`).
   Pass ONLY the inputs above — do NOT include experiment.yaml content,
   project name, or feature descriptions.

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

If no friction detected, continue to Step B2.5 (compliance audit still runs).

### Step B2.5: Compliance Audit (Layer 2)

Run deterministic cross-artifact consistency checks:
```bash
SKILL=$(python3 -c "import json;print(json.load(open('.runs/<skill>-context.json'))['skill'])")
RUN_ID=$(python3 -c "import json;print(json.load(open('.runs/<skill>-context.json')).get('run_id',''))")
python3 .claude/scripts/compliance-audit.py --skill "$SKILL" --run-id "$RUN_ID"
```

Read `.runs/compliance-audit-result.json`. Record `anomaly_count`.

If `anomaly_count > 0`:
- Record anomalies as additional friction items
- Set `friction_detected = true` for Step B3 evaluation

If `anomaly_count == 0` AND no friction from Step B2:
- Skip to Step B2.6 (sampling decision) then Step B4

### Step B2.6: Adaptive LLM Audit Decision (Layer 3)

Determine whether to trigger deep LLM semantic audit:
```bash
Q_SCORE=$(python3 -c "
import json
try:
    with open('.runs/verify-history.jsonl') as f:
        lines = f.readlines()
    last = json.loads(lines[-1]) if lines else {}
    print(last.get('q_skill', 1.0))
except: print('1.0')
" 2>/dev/null || echo "1.0")
ANOMALIES=$(python3 -c "import json;print(json.load(open('.runs/compliance-audit-result.json')).get('anomaly_count',0))" 2>/dev/null || echo "0")
python3 .claude/scripts/audit-sample.py --anomaly-count "$ANOMALIES" --q-score "$Q_SCORE" --run-id "$RUN_ID"
```

Read the JSON output. If `trigger` is `true`:
- Perform **inline** LLM reasoning over compliance anomalies (do NOT spawn a subagent)
- For each failing check in `compliance-audit-result.json`:
  - Assess: Is this a genuine process violation or an expected edge case?
    (e.g., mtime skew from filesystem latency is expected; missing required checks is genuine)
  - Record assessment
- If genuine violations found, treat as friction for Step B3 Path 2 evaluation
- Write findings to `observe-result.json` under `compliance_audit_notes` field

If `trigger` is `false`:
- Skip LLM audit, proceed to Step B3/B4

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
