#!/usr/bin/env bash
# advance-state.sh — Advances a skill's state machine by adding a state to completed_states.
# Usage: bash .claude/scripts/advance-state.sh <skill> <state_number>
# Examples:
#   bash .claude/scripts/advance-state.sh verify 1
#   bash .claude/scripts/advance-state.sh bootstrap 3a
# Guarded by state-completion-gate.sh hook which validates postconditions before allowing execution.
set -euo pipefail
SKILL="$1"
STATE_NUM="$2"
PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

# Determine context file — verify uses verify-context.json, others use <skill>-context.json
if [[ "$SKILL" == "verify" ]]; then
  CTX="$PROJECT_DIR/.runs/verify-context.json"
else
  CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"
fi

# Fail-closed: verify STATE_NUM exists in registry
REGISTRY="$PROJECT_DIR/.claude/patterns/state-registry.json"
if [[ -f "$REGISTRY" ]]; then
  STATE_EXISTS=$(python3 -c "
import json
reg = json.load(open('$REGISTRY'))
print('yes' if '$STATE_NUM' in reg.get('$SKILL', {}) else 'no')
" 2>/dev/null || echo "error")
  if [[ "$STATE_EXISTS" == "no" ]]; then
    echo "ERROR: advance-state.sh — $SKILL.$STATE_NUM not in state-registry.json" >&2
    exit 1
  fi
fi

python3 -c "
import json, os
f='$CTX'; d=json.load(open(f))
cs=d.get('completed_states',[])
state='$STATE_NUM'
# Normalize: try int first, fall back to string (for states like '3a', '1_5')
# Guard against PEP 515: int('1_5') silently returns 15
try:
    if '_' not in state:
        state=int(state)
except ValueError:
    pass
if state not in cs: cs.append(state)
d['completed_states']=cs
# Mark context as completed when all required states are present
reg_path = os.path.join('$PROJECT_DIR', '.claude/patterns/state-registry.json')
if os.path.exists(reg_path):
    reg = json.load(open(reg_path))
    req = reg.get('agent_gates', {}).get('$SKILL', {}).get('_required_states', [])
    if req:
        cs_set = set(str(s) for s in cs)
        req_set = set(str(s) for s in req)
        if req_set.issubset(cs_set):
            d['completed'] = True
json.dump(d, open(f, 'w'))
"
