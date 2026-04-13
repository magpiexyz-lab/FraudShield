#!/usr/bin/env bash
# adversarial-merge-gate.sh — Claude Code PreToolUse hook for Write/Edit.
# Layer 3 adversarial integrity: validates challenge/adversarial artifacts
# match source agent traces. Consolidated gate for resolve, review, change.
# Blocks on mismatch between artifact labels and trace verdicts.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")

case "$FILE_PATH" in
  *resolve-challenge*)
    extract_write_content
    [[ -z "$CONTENT" ]] && exit 0
    PROJECT_DIR=$(get_project_dir)
    VALIDATION=$(echo "$CONTENT" | python3 -c "
import json, sys, os
content = sys.stdin.read().strip()
try:
    merge = json.loads(content)
except Exception:
    print('PARSE_ERROR'); sys.exit(0)
traces_dir = os.environ.get('CLAUDE_PROJECT_DIR', '.') + '/.runs/agent-traces'
# Read trace names from agent registry
_reg_path = os.path.join(os.environ.get('CLAUDE_PROJECT_DIR', '.'), '.claude/patterns/agent-registry.json')
try:
    _adv = json.load(open(_reg_path)).get('merge_gates', {}).get('adversarial', {}).get('resolve', {})
except Exception:
    _adv = {}
rc_path = os.path.join(traces_dir, _adv.get('light_trace', 'resolve-challenger') + '.json')
sc_path = os.path.join(traces_dir, _adv.get('full_trace', 'solve-critic') + '.json')
if not os.path.exists(rc_path) and not os.path.exists(sc_path):
    print(f'FAIL:No adversarial trace found ({os.path.basename(rc_path)} or {os.path.basename(sc_path)})')
    sys.exit(0)
errors = []
challenges = merge.get('challenges', [])
if os.path.exists(rc_path):
    # Light mode: per-item label matching against resolve-challenger trace
    trace = json.load(open(rc_path))
    tv = trace.get('verdicts', [])
    for i, c in enumerate(challenges):
        al = c.get('agent_label')
        if i < len(tv):
            tl = tv[i].get('label')
            if al != tl:
                errors.append(f'challenges[{i}].agent_label={al!r} but trace verdict={tl!r}')
elif os.path.exists(sc_path):
    # Full mode: scalar field matching against solve-critic trace
    trace = json.load(open(sc_path))
    t_ta = trace.get('type_a_count')
    m_ta = merge.get('round_1_type_a_count')
    if t_ta is not None and m_ta is not None and t_ta != m_ta:
        errors.append(f'round_1_type_a_count mismatch: merge={m_ta}, trace={t_ta}')
    t_round = trace.get('round')
    m_round = merge.get('critic_rounds')
    if t_round is not None and m_round is not None and t_round != m_round:
        errors.append(f'critic_rounds mismatch: merge={m_round}, trace round={t_round}')
if errors:
    print('FAIL:' + '; '.join(errors))
else:
    print('OK')
" 2>/dev/null || echo "OK")
    handle_validation "$VALIDATION" "Adversarial merge gate (resolve)" "Challenge artifact must match resolve-challenger trace."
    exit 0
    ;;

  *review-adversarial*)
    extract_write_content
    [[ -z "$CONTENT" ]] && exit 0
    PROJECT_DIR=$(get_project_dir)
    VALIDATION=$(echo "$CONTENT" | python3 -c "
import json, sys, os
content = sys.stdin.read().strip()
try:
    merge = json.loads(content)
except Exception:
    print('PARSE_ERROR'); sys.exit(0)
traces_dir = os.environ.get('CLAUDE_PROJECT_DIR', '.') + '/.runs/agent-traces'
# Read trace name from agent registry
_reg_path = os.path.join(os.environ.get('CLAUDE_PROJECT_DIR', '.'), '.claude/patterns/agent-registry.json')
try:
    _review_trace = json.load(open(_reg_path)).get('merge_gates', {}).get('adversarial', {}).get('review', {}).get('trace', 'review-challenger')
except Exception:
    _review_trace = 'review-challenger'
trace_path = os.path.join(traces_dir, _review_trace + '.json')
if not os.path.exists(trace_path):
    print(f'FAIL:{os.path.basename(trace_path)} trace not found -- cannot validate adversarial artifact')
    sys.exit(0)
trace = json.load(open(trace_path))
tv = trace.get('verdicts', [])
errors = []
# Build a lookup from trace verdicts by finding title
trace_by_finding = {v.get('finding'): v.get('label') for v in tv}
for lst_name in ('confirmed', 'disputed', 'needs_evidence'):
    for i, item in enumerate(merge.get(lst_name, [])):
        if not isinstance(item, dict):
            continue
        ac = item.get('agent_classification')
        finding = item.get('finding', '')
        tl = trace_by_finding.get(finding)
        if tl and ac and ac != tl:
            errors.append(f'{lst_name}[{i}] ({finding}): agent_classification={ac!r} but trace={tl!r}')
if errors:
    print('FAIL:' + '; '.join(errors))
else:
    print('OK')
" 2>/dev/null || echo "OK")
    handle_validation "$VALIDATION" "Adversarial merge gate (review)" "Adversarial artifact must match review-challenger trace."
    exit 0
    ;;

  *change-challenge*)
    # Check if solve_depth is "full" — skip trace validation for light mode
    PROJECT_DIR=$(get_project_dir)
    SOLVE_DEPTH=$(python3 -c "
import json
try:
    ctx = json.load(open('$PROJECT_DIR/.runs/change-context.json'))
    print(ctx.get('solve_depth', 'light'))
except Exception:
    print('light')
" 2>/dev/null || echo "light")

    if [[ "$SOLVE_DEPTH" != "full" ]]; then
      exit 0
    fi

    CHANGE_CHECKS=$(read_agent_registry_field "merge_gates.adversarial.change.checks")
    [[ -z "$CHANGE_CHECKS" ]] && exit 0
    run_merge_gate "change-challenge" "$CHANGE_CHECKS" "Adversarial merge gate (change)"
    ;;

  *)
    exit 0
    ;;
esac
