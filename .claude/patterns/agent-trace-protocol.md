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
