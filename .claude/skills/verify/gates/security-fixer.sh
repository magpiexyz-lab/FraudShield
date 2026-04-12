#!/usr/bin/env bash
# security-fixer.sh — Convention gate for security-fixer agent in /verify
# Extracted from agent-state-gate.sh _verify_security_fixer_checks()
# Called by: skill-agent-gate.sh (PR 5) after declarative checks pass
set -euo pipefail

source "$(dirname "$0")/../../../hooks/lib.sh"

# Accept env vars (convention gate protocol) or derive from payload/defaults
if [[ -z "${PAYLOAD:-}" ]]; then parse_payload; fi
SUBAGENT_TYPE="${SUBAGENT_TYPE:-$(read_payload_field "tool_input.subagent_type")}"
PROJECT_DIR="${PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}"
TRACES_DIR="${TRACES_DIR:-$PROJECT_DIR/.runs/agent-traces}"
ERRORS=()

check_postcondition_artifacts 3

# Phase 1 trace
if [[ ! -f "$TRACES_DIR/build-info-collector.json" ]]; then
  ERRORS+=("build-info-collector.json trace missing — Phase 1 has not completed")
fi
require_trace_verdict "$TRACES_DIR/build-info-collector.json" "agent may still be running or exhausted turns"
check_trace_run_id "$TRACES_DIR/build-info-collector.json"

# Phase 2 traces (scope-conditional)
SF_SCOPE=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "scope")
SF_ARCH=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "archetype")
if [[ "$SF_ARCH" == "web-app" && ( "$SF_SCOPE" == "full" || "$SF_SCOPE" == "visual" ) ]]; then
  for AGENT in design-critic ux-journeyer; do
    if [[ ! -f "$TRACES_DIR/$AGENT.json" ]]; then
      ERRORS+=("$AGENT.json trace missing — Phase 2 agent incomplete (scope=$SF_SCOPE, archetype=$SF_ARCH)")
    else
      require_trace_verdict "$TRACES_DIR/$AGENT.json" "agent may still be running or exhausted turns"
      check_trace_run_id "$TRACES_DIR/$AGENT.json"
    fi
  done
fi

# Tier 1 retry: ux-journeyer must complete
check_tier1_retry_complete "ux-journeyer" "$TRACES_DIR"

# HARD GATE: design-ux-merge.json verdict must not be "fail"
if [[ "$SF_ARCH" == "web-app" && ( "$SF_SCOPE" == "full" || "$SF_SCOPE" == "visual" ) ]]; then
  if [[ -f "$PROJECT_DIR/.runs/design-ux-merge.json" ]]; then
    MERGE_VERDICT=$(read_json_field "$PROJECT_DIR/.runs/design-ux-merge.json" "verdict")
    if [[ "$MERGE_VERDICT" == "fail" ]]; then
      ERRORS+=("design-ux-merge.json verdict=fail — hard gate failure, skip to STATE 7")
    fi
  fi
fi

# scope=security requires behavior-verifier
if [[ "$SF_SCOPE" == "security" ]]; then
  if [[ ! -f "$TRACES_DIR/behavior-verifier.json" ]]; then
    ERRORS+=("behavior-verifier.json trace missing — Phase 1 agent incomplete (scope=$SF_SCOPE)")
  fi
  require_trace_verdict "$TRACES_DIR/behavior-verifier.json" "agent may still be running or exhausted turns"
  check_trace_run_id "$TRACES_DIR/behavior-verifier.json"
fi

check_efficiency_directives

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "security-fixer gate blocked: " "Complete prerequisites before spawning security-fixer."
fi

exit 0
