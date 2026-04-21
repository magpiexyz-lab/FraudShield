# Agent Trace Protocol

Canonical schema for agent trace initialization and completion output.
Referenced by all agent definitions that write traces to `.runs/agent-traces/`.

## The Three Axes

Every trace is an **authenticated assertion** about what one spawned agent did.
Three orthogonal axes:

1. **Identity** — which run this trace belongs to (`run_id`, `skill`).
2. **Provenance** — who wrote this trace (`provenance`: self / self-degraded / recovery / lead-merge). Each value has enforceable write-path preconditions — see §Provenance below.
3. **Verdict** — what outcome is claimed (`verdict`). Independent of provenance. When `provenance != self`, the verdict is validated by independent evidence (`recovery_validated`) before downstream gates accept it.

This triangulation is the coherent fix for issues #941, #958, #960, #963.

## Initialization

Every agent's **First Action** must call:

```bash
python3 scripts/init-trace.py <agent-name>
```

This writes a started-only trace to `.runs/agent-traces/<agent-name>.json`
signaling the agent began work. The stub has `status:"started"` and no
`verdict` / `provenance` — those are only valid on the completion trace.
If the agent crashes before writing its completion trace, the orchestrator
can distinguish "never finished" (stub still present) from "never spawned"
(no stub).

## Completion Trace Schema

After completing all work, write the final trace:

```bash
RUN_ID=$(python3 -c "import json;print(json.load(open('.runs/verify-context.json')).get('run_id',''))" 2>/dev/null || echo "")
mkdir -p .runs/agent-traces && echo '{"agent":"<agent-name>","timestamp":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","status":"completed","verdict":"<verdict>","provenance":"self","partial":false,"checks_performed":[<checks>],"run_id":"'"$RUN_ID"'"}' > .runs/agent-traces/<agent-name>.json
```

### Base Fields (required)

| Field | Type | Description |
|-------|------|-------------|
| `agent` | string | Agent name (e.g., `"observer"`, `"spec-reviewer"`) |
| `timestamp` | string | ISO 8601 UTC timestamp |
| `status` | `"started"` \| `"completed"` \| `"abandoned"` | `"started"` at init; `"completed"` after normal or self-degraded completion; `"abandoned"` for recovery traces |
| `verdict` | string | Agent-specific verdict (see below); required when `status != "started"` |
| `provenance` | `"self"` \| `"self-degraded"` \| `"recovery"` \| `"lead-merge"` | Who wrote this trace. See §Provenance below. Omitted at `init-trace.py`; required at completion |
| `partial` | boolean | `true` when the trace reflects less than the agent's full declared work; MUST be `true` when `provenance != "self"` |
| `checks_performed` | string[] | List of check/step identifiers actually completed |
| `run_id` | string | Run ID from the active context (resolved via `resolve_active_identity`); empty string if unavailable |

### Provenance-specific Fields (required by provenance)

| Field | Type | Required when | Description |
|-------|------|--------------|-------------|
| `degraded_reason` | string | `provenance ∈ {self-degraded, recovery}` | Short, specific cause (e.g., `"image exceeded 2000px"`) |
| `fixes` | array | Fixer agents when claiming changes | `[{file, type, ...}]` — each `file` must appear in `git diff`/`status` for `recovery_validated` to pass |
| `no_fixes_claimed` | boolean | Findings-only agents with no `fixes` | `true` declares the agent deliberately made no changes. Accepted only when agent is listed in `agent-registry.json.non_fixer_agents` |
| `contributing_spawn_indexes` | integer[] | `provenance == "lead-merge"` | List of `spawn_index` values from `agent-spawn-log.jsonl` this aggregate composes. Count must equal spawn-log entries for this base agent in current run_id |
| `spawn_sha` | string | Written by `write-recovery-trace.sh` / `write-degraded-trace.py` | SHA captured at spawn time (from spawn-log entry); used by `validate-recovery.sh` for diff-fix correlation |
| `recovery_validated` | boolean | Written by `validate-recovery.sh` | `true` iff build + e2e + diff evidence confirms the verdict. Required `true` for `provenance ∈ {self-degraded, recovery}` to pass `verify-report-gate.sh` |
| `recovery` | boolean | Legacy mirror | `true` when `provenance == "recovery"`; maintained only for read-side backward compat |
| `recovery_reason` | string | Written by `write-recovery-trace.sh` | Copy of the `--reason` argument that was passed to the recovery script |

## Provenance — The Four Write Paths

| Provenance | Who writes | When | Preconditions enforced by |
|-----------|-----------|------|---------------------------|
| `self` | The agent itself, at end of run | Normal completion | `artifact-integrity-gate.sh` (schema) + universal provenance check in `state-completion-gate.sh` (spawn evidence) |
| `self-degraded` | The agent itself, on detected partial | Agent self-detected partial (image-limit, screenshot crash, turn-budget, tool unavailable) and calls `scripts/write-degraded-trace.py` | Same as `self` + `status == "completed"` + `partial == true` + `degraded_reason != null` (enforced by artifact-integrity-gate) |
| `recovery` | Orchestrator via `scripts/write-recovery-trace.sh` | Agent crashed so hard it could not self-report | (a) spawn-log entry from `skill-agent-gate` exists for this agent in current run_id; (b) target trace absent or stub (`status:"started"` no `verdict`); (c) `--reason` mandatory; (d) agent NOT in `recovery_forbidden` list (enforced by the script) |
| `lead-merge` | Orchestrator, composing from sibling traces | Aggregate from per-item parallel fan-out (e.g., design-critic.json merged from design-critic-landing.json / design-critic-pricing.json), or implementer worktree trace | `contributing_spawn_indexes.length == count(spawn-log entries for base in run_id)` (enforced by state-completion-gate `lead-merge` exemption) |

Callers MUST NOT invent new provenance values. Adding a new value requires
updating `artifact-integrity-gate.sh` per-provenance validation, the
`hard_gates` rules in `agent-registry.json`, and the universal provenance
check in `state-completion-gate.sh`.

### Extension Fields (agent-specific, optional)

Agents may add fields beyond the base schema to capture agent-specific metrics:

| Agent | Extra field | Type | Description |
|-------|------------|------|-------------|
| observer | `fixes_evaluated` | number | Count of fixes evaluated from fix-log |
| build-info-collector | `files_collected` | number | Count of files in diff collection |

### Verdict Values

Each agent defines its own verdict vocabulary. **Casing is normative** — write
verdicts exactly as shown in the table below. Consumers perform defensive
normalization (`.upper()` / `.lower()`), but agents must match the canonical form.

> **Scope note:** This casing requirement applies to agent-trace verdicts
> (LLM-generated). Gate verdicts (written by template-controlled gate-keeper
> code) use their own casing convention and are not governed by this table.

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
