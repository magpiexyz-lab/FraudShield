#!/usr/bin/env bash
# ux-journeyer.sh — Convention gate for ux-journeyer agent in /verify
# Extracted from agent-state-gate.sh _verify_design_ux_checks() (ux-journeyer branch)
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
UX_ARCH=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "archetype")
if [[ "$UX_ARCH" != "web-app" ]]; then
  ERRORS+=("$SUBAGENT_TYPE requires archetype=web-app but got archetype=$UX_ARCH")
fi

check_postcondition_artifacts 0
check_build_result

# Phase 1 traces must exist
if [[ ! -f "$TRACES_DIR/build-info-collector.json" ]]; then
  ERRORS+=("build-info-collector.json trace missing — Phase 1 has not completed")
fi
require_trace_verdict "$TRACES_DIR/build-info-collector.json" "agent may still be running or exhausted turns"
check_trace_run_id "$TRACES_DIR/build-info-collector.json"

# design-critic: check retry completion
check_tier1_retry_complete "design-critic-*" "$TRACES_DIR"
check_tier1_retry_complete "design-critic" "$TRACES_DIR"

# design-consistency-checker prerequisite (scope-conditional)
UX_SCOPE=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "scope")
if [[ "$UX_SCOPE" =~ ^(full|visual)$ ]] && [[ "$UX_ARCH" == "web-app" ]]; then
  if [[ ! -f "$TRACES_DIR/design-consistency-checker.json" ]]; then
    ERRORS+=("design-consistency-checker.json trace missing — spawn consistency checker before ux-journeyer")
  else
    require_trace_verdict "$TRACES_DIR/design-consistency-checker.json" "consistency checker may still be running or exhausted turns"
  fi
fi

check_efficiency_directives

if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "ux-journeyer gate blocked: " "Complete prerequisites before spawning ux-journeyer."
fi

exit 0
