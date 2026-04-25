#!/usr/bin/env bash
# run-all.sh — run every test in .claude/scripts/tests/ and report the aggregate.
# Fails on first failing suite so CI can surface the root cause quickly.
set -euo pipefail

cd "$(dirname "$0")/../../.."

SUITES=(
  ".claude/scripts/tests/test_trace_schema.py"
  ".claude/scripts/tests/test_resolve_active_identity.py"
  ".claude/scripts/tests/test_write_recovery.py"
  ".claude/scripts/tests/test_forgery_surface.py"
  ".claude/scripts/tests/test_validate_recovery.py"
  ".claude/scripts/tests/test_migrate_legacy_traces.py"
  ".claude/scripts/tests/test_hard_gate_predicates.py"
  ".claude/scripts/tests/test_agent_trace_write_guard.py"
  ".claude/scripts/tests/test_transient_teardown.py"
  ".claude/scripts/tests/test_state3b_review_method_merge.py"
  ".claude/scripts/tests/test_derive_pages.py"
  ".claude/scripts/tests/test_verify_semantics.py"
  ".claude/scripts/tests/test_field_role_map_rule.py"
  ".claude/scripts/tests/test_validate_behavior_pages.py"
  ".claude/scripts/tests/test_aoc_coherence_rules.py"
  ".claude/scripts/tests/test_write_agent_trace.py"
  ".claude/scripts/tests/test_augment_trace.py"
  ".claude/scripts/tests/test_lead_fix_path.py"
  ".claude/scripts/tests/test_recovery_run_id_override.py"
)

FAIL=0
for s in "${SUITES[@]}"; do
  echo "━━━ $s ━━━"
  if python3 "$s"; then
    echo "PASS: $s"
  else
    echo "FAIL: $s"
    FAIL=1
    break
  fi
  echo
done

if [[ $FAIL -eq 0 ]]; then
  echo
  echo "ALL AGENT-TRACE LIFECYCLE TESTS PASSED"
else
  exit 1
fi
