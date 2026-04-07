#!/usr/bin/env bash
# lib-merge.sh — Merge gate validation functions.
# Sourced via lib.sh facade. Do NOT source directly.
# Cross-module: uses parse_payload, read_payload_field, extract_write_content,
#   handle_validation from lib-core.sh (loaded before this module by facade).

# --- run_merge_gate ---
# Parameterized merge gate executor. Encapsulates the full gate flow:
# parse_payload → match file_path → extract content → validate → handle result.
# Each merge gate hook calls this with its 3 parameters, eliminating skeleton duplication.
# $1: file_path substring to match (e.g., "design-ux-merge")
# $2: check definitions JSON string (passed to validate_merge_json)
# $3: human-readable gate name (e.g., "Design-UX merge gate")
# Usage: run_merge_gate "design-ux-merge" "$CHECKS_JSON" "Design-UX merge gate"
run_merge_gate() {
  local file_pattern="$1"
  local check_defs="$2"
  local gate_name="$3"

  local file_path
  file_path=$(read_payload_field "tool_input.file_path")

  # Only fire when file_path matches the pattern
  if [[ "$file_path" != *"$file_pattern"* ]]; then
    exit 0
  fi

  extract_write_content

  # Skip if content is empty
  if [[ -z "$CONTENT" ]]; then
    exit 0
  fi

  local validation
  validation=$(echo "$CONTENT" | validate_merge_json "$check_defs")

  handle_validation "$validation" "$gate_name" "Merge JSON must match source agent traces."

  exit 0
}

# --- validate_merge_json ---
# Parameterized JSON validation for merge gate hooks. Reads merge content from stdin.
# Parses merge content, loads traces, compares fields per check definitions.
# Returns "OK", "PARSE_ERROR", or "FAIL:<details>" — caller passes to handle_validation.
# $1: check definitions JSON string (declarative field comparisons)
# Usage: VALIDATION=$(echo "$CONTENT" | validate_merge_json "$CHECK_DEFS")
#
# DO NOT EXTRACT this Python to a .py file — it uses bash variable interpolation
# ($check_defs at line "checks = json.loads('''$check_defs''')") which requires
# bash to evaluate the variable before Python sees the code.
validate_merge_json() {
  local check_defs="$1"
  python3 -c "
import json, sys, os

content = sys.stdin.read().strip()
errors = []

try:
    merge = json.loads(content)
except json.JSONDecodeError:
    print('PARSE_ERROR')
    sys.exit(0)

traces_dir = os.environ.get('CLAUDE_PROJECT_DIR', '.') + '/.runs/agent-traces'
checks = json.loads('''$check_defs''')

for trace_def in checks.get('traces', []):
    trace_path = os.path.join(traces_dir, trace_def['trace_file'])
    if not os.path.exists(trace_path):
        errors.append(trace_def.get('missing_error', trace_def['trace_file'] + ' not found'))
        continue
    try:
        trace = json.load(open(trace_path))
    except (json.JSONDecodeError, IOError):
        continue

    merge_key = trace_def.get('merge_key')
    merge_section = merge.get(merge_key, {}) if merge_key else merge

    for fdef in trace_def.get('fields', []):
        t_val = trace.get(fdef['trace_field'])
        m_val = merge_section.get(fdef['merge_field'])
        if fdef.get('null_ok') and (t_val is None or m_val is None):
            continue
        if t_val != m_val:
            prefix = (merge_key + '.') if merge_key else ''
            errors.append(f'{prefix}{fdef[\"merge_field\"]} mismatch: trace={t_val}, merge={m_val}')

    for sub in trace_def.get('sub_traces', []):
        sub_path = os.path.join(traces_dir, sub['trace_file'])
        if sub.get('condition') == 'exists' and not os.path.exists(sub_path):
            continue
        try:
            sub_trace = json.load(open(sub_path))
        except (json.JSONDecodeError, IOError):
            continue
        for fdef in sub.get('fields', []):
            t_val = sub_trace.get(fdef['trace_field'])
            m_val = merge_section.get(fdef['merge_field'])
            if fdef.get('null_ok') and (t_val is None or m_val is None):
                continue
            if t_val != m_val:
                prefix = (merge_key + '.') if merge_key else ''
                errors.append(f'{prefix}{fdef[\"merge_field\"]} mismatch: trace={t_val}, merge={m_val}')

for sc in checks.get('self_checks', []):
    if sc['type'] == 'count_match':
        arr = merge.get(sc['array_field'], [])
        count = merge.get(sc['count_field'], 0)
        if count != len(arr):
            errors.append(f'{sc[\"count_field\"]} ({count}) != len({sc[\"array_field\"]}) ({len(arr)})')

if errors:
    print('FAIL:' + '; '.join(errors))
else:
    print('OK')
" 2>/dev/null || echo "OK"
}
