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
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Determine context file — verify uses verify-context.json, others use <skill>-context.json
if [[ "$SKILL" == "verify" ]]; then
  CTX="$PROJECT_DIR/.claude/runs/verify-context.json"
else
  CTX="$PROJECT_DIR/.claude/runs/${SKILL}-context.json"
fi

python3 -c "
import json
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
d['completed_states']=cs; json.dump(d,open(f,'w'))
"
