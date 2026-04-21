#!/usr/bin/env bash
# artifact-integrity-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Layer 1 of Three-Layer Compliance Architecture.
# Validates JSON schema on agent trace and gate verdict writes.
# Fail-open on parse errors — never blocks on malformed JSON.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")

# Block direct writes to hook-managed spawn-log
case "$FILE_PATH" in
  *agent-spawn-log.jsonl)
    deny "Artifact integrity gate: agent-spawn-log.jsonl is hook-managed. Cannot be written directly." ;;
esac

# Only fire for agent-traces/*.json and gate-verdicts/*.json
case "$FILE_PATH" in
  *agent-traces/*.json|*gate-verdicts/*.json) ;;
  *) exit 0 ;;
esac

# Skip if no active skill context (normal conversation)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
shopt -s nullglob
CTX_FILES=("$PROJECT_DIR"/.runs/*-context.json)
shopt -u nullglob
if [[ ${#CTX_FILES[@]} -eq 0 ]]; then
  exit 0
fi

extract_write_content

if [[ -z "$CONTENT" ]]; then
  exit 0
fi

# Export file path for Python to classify artifact type
export _ARTIFACT_PATH="$FILE_PATH"

VALIDATION=$(echo "$CONTENT" | python3 -c '
import json, sys, os, re

content = sys.stdin.read().strip()
file_path = os.environ.get("_ARTIFACT_PATH", "")

try:
    d = json.loads(content)
except (json.JSONDecodeError, ValueError):
    print("PARSE_ERROR")
    sys.exit(0)

if not isinstance(d, dict):
    print("PARSE_ERROR")
    sys.exit(0)

errors = []

# --- Classify artifact type ---

is_gate_verdict = "gate-verdicts/" in file_path
is_agent_trace = "agent-traces/" in file_path

if is_gate_verdict:
    # Gate verdict schema: gate, verdict, branch, timestamp, checks
    for field in ("gate", "verdict", "branch", "timestamp"):
        if field not in d or not isinstance(d[field], str) or not d[field]:
            errors.append(f"gate verdict missing or empty: {field}")
    if "checks" not in d or not isinstance(d.get("checks"), list):
        errors.append("gate verdict missing checks array")

elif is_agent_trace:
    # Skip full validation for init traces (status: started)
    if d.get("status") == "started":
        for field in ("agent", "status", "timestamp"):
            if field not in d or not isinstance(d[field], str) or not d[field]:
                errors.append(f"init trace missing or empty: {field}")
        if errors:
            print("FAIL:" + "; ".join(errors))
        else:
            print("OK")
        sys.exit(0)

    # Determine agent category from filename
    basename = os.path.basename(file_path).replace(".json", "")

    # Scaffold and implementer agents — minimal schema (status-based)
    scaffold_prefixes = ("scaffold-", "implementer-", "visual-implementer-")
    is_scaffold = any(basename.startswith(p) for p in scaffold_prefixes)

    # Verdict agents — read from registry
    _reg_path = os.path.join(os.environ.get("CLAUDE_PROJECT_DIR", "."), ".claude/patterns/agent-registry.json")
    try:
        verdict_agents = set(json.load(open(_reg_path)).get("verdict_agents", []))
    except Exception:
        verdict_agents = set()
    # Match by prefix for per-page traces like design-critic-landing
    is_verdict_agent = basename in verdict_agents or any(
        basename.startswith(va + "-") for va in verdict_agents
    )

    if is_scaffold:
        for field in ("agent", "status"):
            if field not in d or not isinstance(d[field], str) or not d[field]:
                errors.append(f"scaffold trace missing or empty: {field}")

    elif is_verdict_agent:
        # Required: agent, timestamp, verdict, checks_performed
        for field in ("agent", "timestamp"):
            if field not in d or not isinstance(d[field], str) or not d[field]:
                errors.append(f"agent trace missing or empty: {field}")

        if "verdict" not in d:
            errors.append("agent trace missing verdict field")
        elif not isinstance(d["verdict"], str):
            errors.append("agent trace verdict must be a string")

        if "checks_performed" not in d:
            errors.append("agent trace missing checks_performed array")
        elif not isinstance(d["checks_performed"], list):
            errors.append("agent trace checks_performed must be an array")
        elif len(d["checks_performed"]) == 0:
            # Allow empty for recovery / self-degraded / lead-merge traces
            prov = d.get("provenance")
            if not d.get("recovery") and prov not in ("recovery", "self-degraded", "lead-merge"):
                errors.append("agent trace checks_performed is empty (set recovery: true or use provenance: self-degraded/recovery if exhausted)")

        # run_id: warn but do not block (backward compat)
        if "run_id" not in d or not d.get("run_id"):
            sys.stderr.write("WARNING: agent trace has empty run_id — trace freshness cannot be verified\n")

        # --- Per-provenance schema validation (v2: agent-trace lifecycle contract) ---
        # Legacy traces (no provenance field) are accepted here and will be
        # migrated later by scripts/migrate-legacy-traces.py.
        prov = d.get("provenance")
        if prov is not None:
            valid_prov = {"self", "self-degraded", "recovery", "lead-merge"}
            if prov not in valid_prov:
                errors.append(f"provenance must be one of {sorted(valid_prov)}; got {prov!r}")
            else:
                # partial flag must be true when provenance != self
                if prov != "self":
                    if not d.get("partial"):
                        errors.append(f"provenance={prov} requires partial:true")
                # self-degraded and recovery both need degraded_reason
                if prov in ("self-degraded", "recovery"):
                    if not d.get("degraded_reason"):
                        errors.append(f"provenance={prov} requires degraded_reason (short cause string)")
                # recovery traces must set the legacy mirror
                if prov == "recovery" and d.get("recovery") is not True:
                    errors.append("provenance=recovery requires recovery:true (legacy mirror)")
                # lead-merge must have contributing_spawn_indexes array
                if prov == "lead-merge":
                    csi = d.get("contributing_spawn_indexes")
                    if not isinstance(csi, list) or len(csi) == 0:
                        errors.append("provenance=lead-merge requires contributing_spawn_indexes (non-empty integer array)")
                    elif not all(isinstance(i, int) for i in csi):
                        errors.append("contributing_spawn_indexes must be integers")
                # self traces should not claim partial
                if prov == "self" and d.get("partial") is True:
                    errors.append("provenance=self with partial:true is contradictory — use provenance=self-degraded instead")

    else:
        # Unknown agent type — validate minimal fields only
        if "agent" not in d or not isinstance(d.get("agent"), str):
            errors.append("trace missing agent field")

if errors:
    print("FAIL:" + "; ".join(errors))
else:
    print("OK")
' 2>/dev/null || echo "OK")

handle_validation "$VALIDATION" "Artifact integrity gate" "Fix trace/verdict JSON schema before writing."
exit 0
