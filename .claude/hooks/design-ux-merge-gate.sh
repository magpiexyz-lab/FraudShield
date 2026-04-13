#!/usr/bin/env bash
# design-ux-merge-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Validates design-ux-merge.json fields match source agent traces.
# Blocks on mismatch between merge JSON and trace data.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

DESIGN_UX_CHECKS=$(read_agent_registry_field "merge_gates.design_ux.checks")
[[ -z "$DESIGN_UX_CHECKS" ]] && exit 0

run_merge_gate "design-ux-merge" "$DESIGN_UX_CHECKS" "Design-UX merge gate"
