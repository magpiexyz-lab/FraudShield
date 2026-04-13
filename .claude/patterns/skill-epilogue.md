# Skill Epilogue — Unified Quality Assurance at Skill Termination

> **Calling convention (as of PR chore/unify-epilogue-qscore):**
> This procedure is now called by `finalize-epilogue.md` after
> `lifecycle-finalize.sh` completes — NOT by individual skill states.
> The strategy (A or B) is determined by finalize.sh and passed in.
> Step 0 (state completion check) is handled by finalize.sh — skip it here.

Follow this procedure at the end of every skill that does NOT embed `/verify`.
Two strategies, dispatched by evidence type:

## Applicability

| Strategy | Skills | When |
|----------|--------|------|
| **A — Code Observation** | `/bootstrap`, `/resolve`, `/review`, `/deploy`, `/spec`, `/upgrade` | Skill produces diffs or modifies template files → spawn observer agent |
| **B — Execution Audit** | `/audit`, `/solve`, `/iterate`, `/observe`, `/retro`, `/rollback`, `/teardown` | Analysis-only, no diffs → inline friction check |

**Skip for:**
- Skills that embed `/verify` (`/change`, `/distribute`) — verify.md STATE 6 handles observation
- `/optimize-prompt` — stateless utility, no state machine
- `/verify` itself — has its own STATE 6 + STATE 7

## Step 0: State completion check — HANDLED BY FINALIZE

> **Skip this step.** `lifecycle-finalize.sh` verifies state completion
> before calling this procedure. If states are incomplete, finalize warns
> but does not block (epilogue is best-effort).

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
cat .claude/template-owned-dirs.txt | grep -v '^#' | grep -v '^$' | xargs -I{} find {} -type f 2>/dev/null | sort
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

This file signals to `skill-agent-gate.sh` that the observer is being
spawned from a skill epilogue (not from verify.md), enabling the relaxed
prerequisite path.

## Step 2.5: Write evidence check artifact

Before evaluating the fast-path, record proof that the evidence scan was performed:

```bash
python3 -c "
import json, os, glob, datetime
fix_log_lines = 0
if os.path.exists('.runs/fix-log.md'):
    with open('.runs/fix-log.md') as f:
        fix_log_lines = max(0, len([l for l in f.readlines() if l.strip()]) - 1)  # exclude header and empty lines
trace_fixes = 0
for tf in glob.glob('.runs/agent-traces/*.json'):
    try:
        data = json.load(open(tf))
        if isinstance(data.get('fixes'), list) and len(data['fixes']) > 0:
            trace_fixes += 1
    except: pass
json.dump({
    'fix_log_entries': fix_log_lines,
    'trace_fixes_found': trace_fixes,
    'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open('.runs/observe-evidence-check.json', 'w'), indent=2)
"
```

This artifact proves the evidence scan ran, even when the verdict is clean.

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
   - If `.runs/<skill>-context.json` contains a non-empty `issue_list`:
     pass issue numbers as exclusion list. Add to observer prompt:
     "This skill run is resolving issues: #N, #M. Do NOT file observations
     that duplicate these issues. If a finding overlaps a resolved issue,
     record it as 'overlaps_resolved' in your trace and skip filing."

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

For analysis-only skills (`/audit`, `/solve`, `/iterate`, `/observe`, `/retro`, `/rollback`, `/teardown`).
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
- Perform **inline** comparison-based evaluation (do NOT spawn a subagent):
- For each failing check in `compliance-audit-result.json`:
  1. **Read the spec**: Load the relevant section from `state-registry.json`
     - `trace_schema_conformance` failures: read `trace_schemas[<skill>]`
     - `agent_trace_coverage` failures: read `trace_schemas[<skill>].expected_agent_traces`
     - `cross_artifact_counts` failures: read both the challenge file and the agent trace
     - `artifact_mtime` failures: compare trace timestamp against file mtime
     - Other failures: use the check `detail` field as context
  2. **Read the artifact**: Load the actual trace/challenge file named in the detail
  3. **Compare**: Diff the spec against the artifact. Which fields are missing, empty, or inconsistent?
  4. **Classify root cause**:
     - **Template spec deficiency**: The state file or methodology doc does not instruct
       the agent to produce the missing field. Evidence: search the state file for the
       field name — if absent, the template never asked for it.
     - **Execution omission**: The spec instructs the agent to produce the field, but
       the agent did not. Evidence: the field name appears in the state file or
       methodology doc but is absent from the artifact.
     - **Expected edge case**: The mismatch is a known benign condition (e.g., mtime
       skew from filesystem latency, epilogue state still executing).
  5. **For template spec deficiencies**: Apply Conditions A/B/C from Step B3 to
     determine whether to file an observation.
- Record all assessments in `observe-result.json` under `compliance_audit_notes` field
- If genuine violations found (template spec deficiency or execution omission),
  treat as friction for Step B3 Path 2 evaluation

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
