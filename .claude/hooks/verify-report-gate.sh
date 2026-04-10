#!/usr/bin/env bash
# verify-report-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Blocks writing verify-report.md unless durable artifacts exist.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")

# Only fire when file_path contains "verify-report"
if [[ "$FILE_PATH" != *"verify-report"* ]]; then
  exit 0
fi

# --- verify-report.md write detected — run artifact checks ---

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
ERRORS=()
WARNINGS=()

extract_write_content

# Detect hard_gate_failure in report content — when true, STATEs 4-6 artifacts
# are correctly absent (hard gate skips them). Checks 5, 7, 15 become conditional.
HAS_HARD_GATE=0
if [[ -n "$CONTENT" ]]; then
  HAS_HARD_GATE=$(echo "$CONTENT" | grep -c 'hard_gate_failure: *true' || echo "0")
fi

# ═══════════════════════════════════════════════════════════════════
# === Section A: Artifact Presence (Checks 1-7, 13b, 15) ===
# ═══════════════════════════════════════════════════════════════════

ARTIFACT_RESULT=$(check_artifact_presence "$PROJECT_DIR" "$HAS_HARD_GATE" "$CONTENT")
_parse_check_result "$ARTIFACT_RESULT"

# ═══════════════════════════════════════════════════════════════════
# === Section B: Agent Trace Verdicts (Checks 8-11, 13) ===
# ═══════════════════════════════════════════════════════════════════

TRACE_DIR="$PROJECT_DIR/.runs/agent-traces"

if [[ -f "$PROJECT_DIR/.runs/verify-context.json" ]]; then
  SCOPE=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "scope")
  ARCH=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "archetype")

  # Check 8: design-ux-merge.json required for full/visual + web-app
  if [[ ("$SCOPE" == "full" || "$SCOPE" == "visual") && "$ARCH" == "web-app" ]]; then
    if [[ ! -f "$PROJECT_DIR/.runs/design-ux-merge.json" ]]; then
      ERRORS+=("design-ux-merge.json not found — Design-UX merge step was skipped (scope=$SCOPE, archetype=$ARCH)")
    fi
  fi

  # Check 9: design-critic hard gate
  check_hard_gate_trace "design-critic" "$TRACE_DIR" \
    '"$F_verdict" == "unresolved" || "$F_recovery" == "True"' \
    verdict recovery

  # Check 10: ux-journeyer hard gate
  check_hard_gate_trace "ux-journeyer" "$TRACE_DIR" \
    '"$F_verdict" == "blocked" || "$F_unresolved_dead_ends" -gt 0 || "$F_recovery" == "True"' \
    verdict unresolved_dead_ends recovery

  # Check 11: security-fixer hard gate
  check_hard_gate_trace "security-fixer" "$TRACE_DIR" \
    '("$F_verdict" == "partial" && "$F_unresolved_critical" -gt 0) || "$F_recovery" == "True"' \
    verdict unresolved_critical recovery

  # Check 13: design-consistency-checker trace required for full/visual + web-app
  if [[ "$SCOPE" =~ ^(full|visual)$ ]] && [[ "$ARCH" == "web-app" ]]; then
    if [[ ! -f "$TRACE_DIR/design-consistency-checker.json" ]]; then
      ERRORS+=("design-consistency-checker.json trace missing for scope=$SCOPE archetype=$ARCH")
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# === Section C: Cross-Artifact Consistency (Checks 12, 14, 16-18) ===
# ═══════════════════════════════════════════════════════════════════

if [[ -n "$CONTENT" ]]; then
  CONSISTENCY_RESULT=$(check_cross_artifact_consistency "$PROJECT_DIR" "$CONTENT")
  _parse_check_result "$CONSISTENCY_RESULT"
fi

# Output warnings to stderr (non-blocking)
if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  for w in "${WARNINGS[@]}"; do
    echo "WARN: $w" >&2
  done
fi

# If any check failed, deny the write
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "Verify report gate blocked: " "Complete all verification steps before writing verify-report.md."
fi

# All checks passed — allow
exit 0
