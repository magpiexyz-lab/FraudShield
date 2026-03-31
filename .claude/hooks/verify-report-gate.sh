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

TRACE_DIR="$PROJECT_DIR/.claude/runs/agent-traces"

if [[ -f "$PROJECT_DIR/.claude/runs/verify-context.json" ]]; then
  SCOPE=$(read_json_field "$PROJECT_DIR/.claude/runs/verify-context.json" "scope")
  ARCH=$(read_json_field "$PROJECT_DIR/.claude/runs/verify-context.json" "archetype")

  # Check 8: design-ux-merge.json required for full/visual + web-app
  if [[ ("$SCOPE" == "full" || "$SCOPE" == "visual") && "$ARCH" == "web-app" ]]; then
    if [[ ! -f "$PROJECT_DIR/.claude/runs/design-ux-merge.json" ]]; then
      ERRORS+=("design-ux-merge.json not found — Design-UX merge step was skipped (scope=$SCOPE, archetype=$ARCH)")
    fi
  fi

  # Check 9: design-critic hard gate
  DC_TRACE="$TRACE_DIR/design-critic.json"
  if [[ -f "$DC_TRACE" ]]; then
    DC_VERDICT=$(read_json_field "$DC_TRACE" "verdict")
    DC_RECOVERY=$(read_json_field "$DC_TRACE" "recovery")
    if [[ "$DC_VERDICT" == "unresolved" || "$DC_RECOVERY" == "True" ]]; then
      if ! echo "$CONTENT" | grep -q 'hard_gate_failure: *true'; then
        ERRORS+=("design-critic verdict=$DC_VERDICT recovery=$DC_RECOVERY requires hard_gate_failure: true in report frontmatter")
      fi
    fi
  fi

  # Check 10: ux-journeyer hard gate
  UX_TRACE="$TRACE_DIR/ux-journeyer.json"
  if [[ -f "$UX_TRACE" ]]; then
    UX_VERDICT=$(read_json_field "$UX_TRACE" "verdict")
    UX_UDE=$(read_json_field "$UX_TRACE" "unresolved_dead_ends")
    UX_RECOVERY=$(read_json_field "$UX_TRACE" "recovery")
    if [[ "$UX_VERDICT" == "blocked" || "$UX_UDE" -gt 0 || "$UX_RECOVERY" == "True" ]]; then
      if ! echo "$CONTENT" | grep -q 'hard_gate_failure: *true'; then
        ERRORS+=("ux-journeyer verdict=$UX_VERDICT unresolved_dead_ends=$UX_UDE recovery=$UX_RECOVERY requires hard_gate_failure: true in report frontmatter")
      fi
    fi
  fi

  # Check 11: security-fixer hard gate
  SF_TRACE="$TRACE_DIR/security-fixer.json"
  if [[ -f "$SF_TRACE" ]]; then
    SF_VERDICT=$(read_json_field "$SF_TRACE" "verdict")
    SF_UC=$(read_json_field "$SF_TRACE" "unresolved_critical")
    SF_RECOVERY=$(read_json_field "$SF_TRACE" "recovery")
    if [[ ("$SF_VERDICT" == "partial" && "$SF_UC" -gt 0) || "$SF_RECOVERY" == "True" ]]; then
      if ! echo "$CONTENT" | grep -q 'hard_gate_failure: *true'; then
        ERRORS+=("security-fixer verdict=$SF_VERDICT unresolved_critical=$SF_UC recovery=$SF_RECOVERY requires hard_gate_failure: true in report frontmatter")
      fi
    fi
  fi

  # Check 13: design-consistency-checker trace required for full/visual + web-app
  if [[ "$SCOPE" =~ ^(full|visual)$ ]] && [[ "$ARCH" == "web-app" ]]; then
    if [[ ! -f "$TRACE_DIR/design-consistency-checker.json" ]]; then
      ERRORS+=("design-consistency-checker.json trace missing for scope=$SCOPE archetype=$ARCH")
    fi
  fi
fi

# ═══════════════════════════════════════════════════════════════════
# === Section C: Cross-Artifact Consistency (Checks 12, 14, 16-19) ===
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
