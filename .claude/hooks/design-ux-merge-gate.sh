#!/usr/bin/env bash
# design-ux-merge-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Validates design-ux-merge.json fields match source agent traces.
# Blocks on mismatch between merge JSON and trace data.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

DESIGN_UX_CHECKS='{
  "traces": [
    {
      "trace_file": "design-critic.json",
      "merge_key": "design_critic",
      "missing_error": "design-critic.json trace not found — cannot validate merge",
      "fields": [
        {"trace_field": "verdict",   "merge_field": "verdict"},
        {"trace_field": "min_score", "merge_field": "min_score", "null_ok": true}
      ],
      "sub_traces": [
        {
          "trace_file": "design-critic-shared.json",
          "condition": "exists",
          "fields": [
            {"trace_field": "fixes_applied", "merge_field": "shared_fixes_applied", "null_ok": true}
          ]
        }
      ]
    },
    {
      "trace_file": "ux-journeyer.json",
      "merge_key": "ux_journeyer",
      "missing_error": "ux-journeyer.json trace not found — cannot validate merge",
      "fields": [
        {"trace_field": "verdict",         "merge_field": "verdict"},
        {"trace_field": "clicks_to_value", "merge_field": "clicks_to_value", "null_ok": true},
        {"trace_field": "dead_ends",       "merge_field": "dead_ends",       "null_ok": true}
      ]
    }
  ],
  "self_checks": []
}'

run_merge_gate "design-ux-merge" "$DESIGN_UX_CHECKS" "Design-UX merge gate"
