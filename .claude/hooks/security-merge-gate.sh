#!/usr/bin/env bash
# security-merge-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Validates security-merge.json fields match source agent traces.
# Blocks on mismatch between merge JSON and trace data.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

SECURITY_CHECKS=$(read_agent_registry_field "merge_gates.security.checks")
[[ -z "$SECURITY_CHECKS" ]] && exit 0

run_merge_gate "security-merge" "$SECURITY_CHECKS" "Security merge gate"
