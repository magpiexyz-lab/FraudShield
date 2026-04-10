# Agent Trace Protocol

Canonical schema for agent trace initialization and completion output.
Referenced by all agent definitions that write traces to `.runs/agent-traces/`.

## Initialization

Every agent's **First Action** must call:

```bash
python3 scripts/init-trace.py <agent-name>
```

This writes a started-only trace to `.runs/agent-traces/<agent-name>.json`
signaling the agent began work. If the agent crashes before writing its
completion trace, the started-only trace lets the orchestrator detect
incomplete work.

## Completion Trace Schema

After completing all work, write the final trace:

```bash
RUN_ID=$(python3 -c "import json;print(json.load(open('.runs/verify-context.json')).get('run_id',''))" 2>/dev/null || echo "")
mkdir -p .runs/agent-traces && echo '{"agent":"<agent-name>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","verdict":"<verdict>","checks_performed":[<checks>],"run_id":"'"$RUN_ID"'"}' > .runs/agent-traces/<agent-name>.json
```

### Base Fields (required)

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent name (e.g., `"observer"`, `"spec-reviewer"`) |
| `timestamp` | string | ISO 8601 UTC timestamp |
| `verdict` | string | Agent-specific verdict (see below) |
| `checks_performed` | string[] | List of check/step identifiers completed |
| `run_id` | string | Run ID from verify-context.json (empty string if unavailable) |

### Extension Fields (agent-specific, optional)

Agents may add fields beyond the base schema to capture agent-specific metrics:

| Agent | Extra field | Type | Description |
|-------|------------|------|-------------|
| observer | `fixes_evaluated` | number | Count of fixes evaluated from fix-log |
| build-info-collector | `files_collected` | number | Count of files in diff collection |

### Verdict Values

Each agent defines its own verdict vocabulary:

| Agent | Possible verdicts |
|-------|------------------|
| observer | `"filed"`, `"commented"`, `"no observations"`, `"prerequisite-unavailable"` |
| spec-reviewer | `"PASS"`, `"FAIL"` |
| build-info-collector | `"collected"`, `"no-fixes"` |
| resolve-challenger | `"N fixes sound, M challenged"` (summary) |
| review-challenger | `"N confirmed, M disputed"` (summary) |
| solve-critic | `"N TYPE A, M TYPE B, K TYPE C"` (summary) |

## Adversarial Agent Extensions

Adversarial agents challenge lead-agent conclusions and must write traces with
additional fields to enable tamper-resistant cross-validation by merge gates.

### Required Extension: `verdicts` array

All adversarial agents include a `verdicts` array — one entry per challenged item.
The adversarial-merge-gate.sh hook cross-references these entries against the lead's
summary artifact to detect silent label overrides.

### Context File Parameter

Adversarial agents operate under skills other than `/verify` (e.g., `/resolve`,
`/review`, `/change`). Use `--context` to specify the correct context file:

```bash
python3 scripts/init-trace.py resolve-challenger --context .runs/resolve-context.json
```

### Adversarial Trace Schemas

**resolve-challenger.json**:
```json
{
  "agent": "resolve-challenger",
  "timestamp": "<ISO8601>",
  "verdict": "<summary>",
  "checks_performed": ["configuration_counterexample", "blast_radius_gap", "regression_vector"],
  "verdicts": [{"issue": "<N>", "label": "<sound|challenged|needs-revision>", "challenge": "<text>", "evidence": "<text>"}],
  "run_id": "<from context>"
}
```

**review-challenger.json**:
```json
{
  "agent": "review-challenger",
  "timestamp": "<ISO8601>",
  "verdict": "<summary>",
  "checks_performed": ["cross_file", "edge_case", "user_journey"],
  "verdicts": [{"finding": "<title>", "label": "<confirmed|disputed|needs-evidence>", "counterexample": "<text>", "evidence": "<text>"}],
  "run_id": "<from context>"
}
```

**solve-critic.json**:
```json
{
  "agent": "solve-critic",
  "timestamp": "<ISO8601>",
  "verdict": "<summary>",
  "checks_performed": ["type_a_analysis", "type_b_analysis", "type_c_analysis"],
  "round": 1,
  "type_a_count": 0,
  "type_b_count": 0,
  "type_c_count": 0,
  "concerns": [{"type": "<A|B|C>", "description": "<text>", "evidence": "<text>", "fix": "<text or null>"}],
  "run_id": "<from context>"
}
```
