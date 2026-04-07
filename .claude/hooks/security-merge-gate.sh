#!/usr/bin/env bash
# security-merge-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Validates security-merge.json fields match source agent traces.
# Blocks on mismatch between merge JSON and trace data.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

SECURITY_CHECKS='{
  "traces": [
    {
      "trace_file": "security-defender.json",
      "merge_key": null,
      "missing_error": "security-defender.json trace not found — cannot validate merge",
      "fields": [
        {"trace_field": "fails_count", "merge_field": "defender_fails"}
      ]
    },
    {
      "trace_file": "security-attacker.json",
      "merge_key": null,
      "missing_error": "security-attacker.json trace not found — cannot validate merge",
      "fields": [
        {"trace_field": "findings_count", "merge_field": "attacker_findings"}
      ]
    }
  ],
  "self_checks": [
    {"type": "count_match", "array_field": "issues", "count_field": "merged_issues"}
  ]
}'

run_merge_gate "security-merge" "$SECURITY_CHECKS" "Security merge gate"
