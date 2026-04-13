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

  # Hard gate checks — read from agent registry
  while IFS=$'\t' read -r _hg_agent _hg_condition _hg_fields; do
    [[ -z "$_hg_agent" ]] && continue
    # shellcheck disable=SC2086
    check_hard_gate_trace "$_hg_agent" "$TRACE_DIR" "$_hg_condition" $_hg_fields
  done < <(python3 -c "
import json, os
reg_path = os.path.join(os.environ.get('CLAUDE_PROJECT_DIR', '.'), '.claude/patterns/agent-registry.json')
try:
    reg = json.load(open(reg_path))
except Exception:
    exit(0)
def rule_to_expr(r):
    f = r['field']
    if 'eq' in r: return '\"\$F_{0}\" == \"{1}\"'.format(f, r['eq'])
    if 'gt' in r: return '\"\$F_{0}\" -gt {1}'.format(f, r['gt'])
    return 'false'
for hg in reg.get('hard_gates', []):
    parts, fields = [], set()
    for rule in hg.get('block_rules', []):
        if 'all' in rule:
            sub = ' && '.join(rule_to_expr(sr) for sr in rule['all'])
            parts.append('(' + sub + ')')
            for sr in rule['all']: fields.add(sr['field'])
        else:
            parts.append(rule_to_expr(rule))
            fields.add(rule['field'])
    print(hg['agent'] + '\t' + ' || '.join(parts) + '\t' + ' '.join(sorted(fields)))
" 2>/dev/null)

  # Trace existence checks — read from agent registry
  while IFS=$'\t' read -r _te_agent _te_scopes _te_arch; do
    [[ -z "$_te_agent" ]] && continue
    if [[ ",$_te_scopes," == *",$SCOPE,"* ]] && [[ "$ARCH" == "$_te_arch" ]]; then
      if [[ ! -f "$TRACE_DIR/${_te_agent}.json" ]]; then
        ERRORS+=("${_te_agent}.json trace missing for scope=$SCOPE archetype=$ARCH")
      fi
    fi
  done < <(python3 -c "
import json, os
reg_path = os.path.join(os.environ.get('CLAUDE_PROJECT_DIR', '.'), '.claude/patterns/agent-registry.json')
try:
    reg = json.load(open(reg_path))
except Exception:
    exit(0)
for tr in reg.get('trace_required', []):
    print(tr['agent'] + '\t' + ','.join(tr['when_scope']) + '\t' + tr['when_archetype'])
" 2>/dev/null)
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
