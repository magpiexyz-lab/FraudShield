# Agent Trace Protocol

Canonical schema for agent trace initialization and completion output.
Referenced by all agent definitions that write traces to `.runs/agent-traces/`.

> **Verdict vocabulary and fix-ledger semantics are governed by
> [Agent Output Contract v1 (AOC v1)](./agent-output-contract.md).**
> This file defines the trace schema plumbing (identity, provenance,
> required fields). The contract defines `allowed_verdicts` /
> `allowed_results` per agent and the `.runs/fix-ledger.jsonl` format.
> Agent definitions should reference both.

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
| `verdict` | string | Core protocol vocabulary (lowercase): `pass` / `fail` / `blocked` / `unresolved`. Required when `status != "started"`. Governed by AOC v1 AVS v1. Gate predicates key on this field only. |
| `result` | string \| null | AOC v1 qualifier: `clean` / `fixed` / `partial` / `degraded` / `skipped` / `none` / `count_summary` / `null`. Required when `agent ∈ verdict_agents` and `status == "completed"`. Preserves pass-clean vs pass-after-fixes distinction. See per-agent `allowed_results` in `agent-registry.json.verdict_agents_schema`. |
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
| `self-degraded` | The agent itself, on detected partial | Agent self-detected degradation. AOC v1 formalizes **two sub-cases**: (a) **execution degradation** — original recovery semantics (image-limit, screenshot crash, turn-budget, tool unavailable); (b) **input degradation** — subject-under-review is degraded (fixture short-circuit, DEMO_MODE dynamic-route 404, stale fixture — introduced by #1042 via Session C). Both call `scripts/write-degraded-trace.py` | Same as `self` + `status == "completed"` + `partial == true` + `degraded_reason != null` (enforced by artifact-integrity-gate) + `recovery_validated == true` for downstream `validated_fallback` acceptance |
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
| design-critic | `review_method` | enum | `"rendered-authed"` / `"rendered-demo"` / `"source-only"` / `"unknown"` — render classification from `.claude/patterns/render-review-detection.md` |
| design-critic | `review_evidence` | object | `{requested_route, final_url, auth_source, fallback_reason, content_density, expected_destination}` — see render-review-detection.md |
| design-critic | `caveat` | string | Present ONLY when `review_method ∈ {"source-only","unknown"}`; value = `review_evidence.fallback_reason`. Omitted otherwise. |
| accessibility-scanner | `per_page_reviews` | array | Runtime path only. One entry per golden_path page: `{page, review_method, review_evidence}`. Omitted in static-fallback path. |
| ux-journeyer | `per_step_reviews` | array | One entry per golden_path step: `{step_index, source_route, expected_destination, review_method, review_evidence, status}`. `status` enforced by `review-verdict-gate.md` per the policy table in `.claude/agents/ux-journeyer.md`. |
| ux-journeyer | `caveat` | string | Present ONLY when `verdict == "blocked"` (e.g., from `prereq-unmet` at journey start). Format: `"prereq-unmet:<fallback_reason>"`. Omitted otherwise. |
| behavior-verifier | `per_behavior_reviews` | array | One entry per behavior with an `entry_route`: `{behavior_id, given, requires_auth, matched_phrase, unmatched_given_phrase, review_method, review_evidence, verdict}`. `verdict` enforced by `review-verdict-gate.md` per the policy table in `.claude/agents/behavior-verifier.md`. |
| behavior-verifier | `unmatched_given_phrase` | string \| null | Top-level diagnostic — first behavior `given` phrase that hit the fail-closed default in `.claude/patterns/given-auth-matcher.md`. When non-null, a maintainer should extend the matcher's whitelist. Omitted when no unmatched phrases were encountered. |
| any reviewer agent | `review_method_gate_evaluated` | boolean | Sentinel written by `.claude/patterns/review-verdict-gate.md` proving the gate ran on this trace. Asserted by `state-registry.json` VERIFY commands for state 2 and state 3c. Always `true` once present. |
| any reviewer agent | `review_method_gate_corrections` | array | One entry per verdict the gate auto-corrected: `{location, review_method, original_verdict, corrected_to}`. Omitted when 0 corrections were applied. |

### Verdict Values (AOC v1)

Agent verdict vocabulary is declared in
**`.claude/patterns/agent-output-contract.md`** (AVS v1) and enumerated
per-agent in **`agent-registry.json.verdict_agents_schema`**
(`allowed_verdicts`, `allowed_results`, `required_structured_fields`).

Core rules (AOC v1):

- `verdict` is one of the **lowercase** four core values: `pass` / `fail` /
  `blocked` / `unresolved`. Gate predicates key on this field only.
- `result` carries the qualifier that preserves pass-clean vs
  pass-after-fixes and other distinctions (see AOC v1 Invariants table).
- **Count-summary agents** (scanner / adversarial) emit `result =
  "count_summary"` plus structured count fields per AOC v1 (e.g.,
  `fails_count`, `findings_count`, `type_a_count`). Gate predicates
  reference those counts via the existing `additional_block_conditions`
  mechanism — no new DSL.
- **Legacy uppercase emissions** (`PASS`, `FAIL`, `DEGRADED`, `SKIPPED`) are
  case-normalized to lowercase by `migrate-legacy-traces.py` on first
  encounter. Self-healing migration is triggered by `verify-report-gate.sh`
  when legacy traces are detected.

> **Scope note:** Gate verdicts (written by template-controlled gate-keeper
> code) use their own casing convention and are not governed by AOC v1.

For legacy-verdict → AVS v1 mappings, see
`.claude/scripts/migrate-legacy-traces.py.LEGACY_VERDICT_MAP`.

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
