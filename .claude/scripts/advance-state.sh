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

# Determine context file — mode-aware for iterate --check/--cross
source "$(dirname "$0")/lifecycle-lib.sh"
read -r SKILL_DIR _SKILL_MODE <<< "$(resolve_skill_dir "$SKILL")"
MANIFEST="$PROJECT_DIR/.runs/${SKILL_DIR}-manifest.json"
CTX=$(resolve_context_path "$SKILL")

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

# Read required states from manifest (already parsed by lifecycle-init.sh)
manifest_path = '$MANIFEST'
if os.path.exists(manifest_path):
    manifest = json.load(open(manifest_path))
    if 'active_mode' in manifest and 'modes' in manifest:
        req = [str(s) for s in manifest['modes'][manifest['active_mode']].get('states', [])]
    else:
        req = [str(s) for s in manifest.get('states', [])]
    if req:
        cs_set = set(str(s) for s in cs)
        if set(req).issubset(cs_set):
            d['completed'] = True

json.dump(d, open(f, 'w'))
"
