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
state=str('$STATE_NUM')
if state not in cs: cs.append(state)
d['completed_states']=cs
# Mark context as completed when all required states are present
import re
# Map mode-qualified skill names to their directory and mode
_skill = '$SKILL'
_MODE_MAP = {'iterate-check': ('iterate', 'check'), 'iterate-cross': ('iterate', 'cross')}
_dir, _mode = _MODE_MAP.get(_skill, (_skill, None))
skill_yaml_path = os.path.join('$PROJECT_DIR', '.claude/skills/%s/skill.yaml' % _dir)
if os.path.exists(skill_yaml_path):
    yt = open(skill_yaml_path).read()
    req = []
    if _mode:
        # Parse modes.<mode>.states
        mp = re.search(r'%s:\s*\n\s+.*?states:\s*\[([^\]]+)\]' % _mode, yt, re.DOTALL)
        if mp:
            req = [s.strip().strip('\"').strip(\"'\") for s in mp.group(1).split(',')]
    else:
        sm = re.search(r'^states:\s*\[([^\]]+)\]', yt, re.MULTILINE)
        if sm:
            req = [s.strip().strip('\"').strip(\"'\") for s in sm.group(1).split(',')]
    if req:
        cs_set = set(str(s) for s in cs)
        req_set = set(str(s) for s in req)
        if req_set.issubset(cs_set):
            d['completed'] = True
json.dump(d, open(f, 'w'))
"
