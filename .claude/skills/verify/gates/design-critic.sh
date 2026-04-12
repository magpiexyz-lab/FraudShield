#!/usr/bin/env bash
# design-critic.sh — Convention gate for design-critic agent in /verify
# Extracted from agent-state-gate.sh _verify_design_ux_checks() (design-critic branch)
# Called by: skill-agent-gate.sh (PR 5) after declarative checks pass
set -euo pipefail

source "$(dirname "$0")/../../../hooks/lib.sh"

# Accept env vars (convention gate protocol) or derive from payload/defaults
if [[ -z "${PAYLOAD:-}" ]]; then parse_payload; fi
SUBAGENT_TYPE="${SUBAGENT_TYPE:-$(read_payload_field "tool_input.subagent_type")}"
PROJECT_DIR="${PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}"
TRACES_DIR="${TRACES_DIR:-$PROJECT_DIR/.runs/agent-traces}"
ERRORS=()

# Archetype guard: design agents are web-app only
DC_ARCH=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "archetype")
if [[ "$DC_ARCH" != "web-app" ]]; then
  ERRORS+=("$SUBAGENT_TYPE requires archetype=web-app but got archetype=$DC_ARCH")
fi

check_postcondition_artifacts 0
check_build_result

# Phase 1 traces must exist
if [[ ! -f "$TRACES_DIR/build-info-collector.json" ]]; then
  ERRORS+=("build-info-collector.json trace missing — Phase 1 has not completed")
fi
require_trace_verdict "$TRACES_DIR/build-info-collector.json" "agent may still be running or exhausted turns"
check_trace_run_id "$TRACES_DIR/build-info-collector.json"

# Scope=full requires additional Phase 1 traces
SCOPE=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "scope")
if [[ "$SCOPE" == "full" ]]; then
  for AGENT in security-defender security-attacker behavior-verifier; do
    if [[ ! -f "$TRACES_DIR/$AGENT.json" ]]; then
      ERRORS+=("$AGENT.json trace missing — Phase 1 agent incomplete (scope=$SCOPE)")
    else
      require_trace_verdict "$TRACES_DIR/$AGENT.json" "agent may still be running or exhausted turns"
      check_trace_run_id "$TRACES_DIR/$AGENT.json"
    fi
  done
fi

# Per-page file boundary enforcement
IS_PER_PAGE=$(python3 -c "
import json, sys, re
d = json.loads(sys.stdin.read())
prompt = d.get('tool_input',{}).get('prompt','')
if re.search(r'design-critic-\w+\.json', prompt):
    print('yes')
else:
    print('no')
" <<< "$PAYLOAD" 2>/dev/null || echo "no")
if [[ "$IS_PER_PAGE" == "yes" ]]; then
  check_file_boundary "design-critic (per-page)"
fi

check_efficiency_directives

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "design-critic gate blocked: " "Complete prerequisites before spawning design-critic."
fi

exit 0
