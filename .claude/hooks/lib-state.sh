#!/usr/bin/env bash
# lib-state.sh — State management and skill detection functions.
# Sourced via lib.sh facade. Do NOT source directly.
# Requires: ERRORS array (from caller). Cross-module: none (self-contained).

# --- normalize_states ---
# Reads completed_states from a context JSON file. Normalizes all entries
# to strings (int 0 → "0", mixed types handled). Outputs space-separated list.
# Returns empty string if file missing, field absent, or parse error.
# Usage: STATES=$(normalize_states "/path/to/context.json")
normalize_states() {
  local ctx_file="$1"
  [[ ! -f "$ctx_file" ]] && { echo ""; return; }
  python3 -c "
import json
try:
    d = json.load(open('$ctx_file'))
    print(' '.join(str(s) for s in d.get('completed_states', [])))
except: print('')
" 2>/dev/null || echo ""
}

# --- get_required_states ---
# Reads _required_states array from agent_gates[$SKILL] in state-registry.json.
# Returns space-separated list of state IDs. Empty string if skill or key missing.
# Usage: REQUIRED=$(get_required_states "bootstrap")
get_required_states() {
  local skill="$1"
  local registry="${CLAUDE_PROJECT_DIR:-.}/.claude/patterns/state-registry.json"
  [[ ! -f "$registry" ]] && { echo ""; return; }
  python3 -c "
import json
d = json.load(open('$registry'))
rs = d.get('agent_gates',{}).get('$skill',{}).get('_required_states',[])
print(' '.join(str(s) for s in rs))
" 2>/dev/null || echo ""
}

# --- compute_missing_states ---
# Pure computation: prints comma-separated missing states, or "NONE" if all present.
# Usage: MISSING=$(compute_missing_states "$STATES" "$REQUIRED")
compute_missing_states() {
  local states="$1" required="$2"
  python3 -c "
cs = set('$states'.split())
required = '$required'.split()
missing = [s for s in required if s not in cs]
print(','.join(missing) if missing else 'NONE')
" 2>/dev/null || echo "NONE"
}

# --- check_skill_completion ---
# Checks that all _required_states for a skill are in completed_states.
# Appends missing states to global ERRORS array. Does not exit — caller decides.
# No-op if _required_states is empty or context file missing (fail-open).
# Usage: check_skill_completion "change" "$PROJECT_DIR/.runs/change-context.json"
check_skill_completion() {
  local skill="$1" ctx_file="$2"
  [[ ! -f "$ctx_file" ]] && return 0
  local STATES REQUIRED MISSING
  STATES=$(normalize_states "$ctx_file")
  REQUIRED=$(get_required_states "$skill")
  [[ -z "$REQUIRED" ]] && return 0
  MISSING=$(compute_missing_states "$STATES" "$REQUIRED")
  if [[ "$MISSING" != "NONE" ]]; then
    ERRORS+=("$skill states [$MISSING] not complete — finish all required states before proceeding")
  fi
}

# --- detect_active_skill_for_branch ---
# Scans *-context.json files, matches branch, returns skill name.
# Returns "" if no matching context found. Follows agent-state-gate.sh pattern.
# Ignores epilogue-context.json and completed contexts.
# Usage: SKILL=$(detect_active_skill_for_branch "$BRANCH")
detect_active_skill_for_branch() {
  local branch="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  python3 -c "
import json, glob, os
branch = '$branch'
project = '$project_dir'
best_skill = ''
best_ts = ''
for f in glob.glob(os.path.join(project, '.runs', '*-context.json')):
    if 'epilogue-context' in f:
        continue
    try:
        d = json.load(open(f))
        if d.get('branch') != branch:
            continue
        if d.get('completed'):
            continue
        ts = d.get('timestamp', '')
        if ts > best_ts:
            best_ts = ts
            best_skill = d.get('skill', '')
    except:
        continue
print(best_skill)
" 2>/dev/null || echo ""
}

# --- get_observation_gate ---
# Reads observation_gates metadata from state-registry.json for a skill.
# Returns the value of a specific field, or "" if not found.
# Usage: MECH=$(get_observation_gate "upgrade" "gate_mechanism")
get_observation_gate() {
  local skill="$1"
  local field="$2"
  local registry="${CLAUDE_PROJECT_DIR:-.}/.claude/patterns/state-registry.json"
  [[ ! -f "$registry" ]] && { echo ""; return; }
  python3 -c "
import json
d = json.load(open('$registry'))
obs = d.get('observation_gates', {}).get('$skill', {})
val = obs.get('$field', '')
if isinstance(val, list):
    print(' '.join(val))
else:
    print(val)
" 2>/dev/null || echo ""
}

# --- parse_advance_state_args ---
# Parse advance-state.sh arguments from a command string.
# Sets SKILL and STATE_ID globals. Expects $COMMAND to be set.
parse_advance_state_args() {
  SKILL=$(echo "$COMMAND" | grep -oE 'advance-state\.sh[[:space:]]+([a-z-]+)' | awk '{print $NF}' || echo "")
  STATE_ID=$(echo "$COMMAND" | grep -oE 'advance-state\.sh[[:space:]]+[a-z-]+[[:space:]]+([0-9a-z_]+)' | awk '{print $NF}' || echo "")
}

# --- get_archetype ---
# Reads archetype from context JSON (matching hook patterns) or experiment.yaml.
# Returns "web-app" if absent or on error.
# Usage: ARCH=$(get_archetype)
get_archetype() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  # 1. Try context JSON files (same pattern as agent-state-gate.sh)
  for f in "$project_dir"/.runs/*-context.json; do
    [[ -f "$f" ]] || continue
    local arch
    arch=$(read_json_field "$f" "archetype")
    [[ -n "$arch" ]] && { echo "$arch"; return; }
  done
  # 2. Fallback to experiment.yaml
  python3 -c "
import yaml
try:
    d = yaml.safe_load(open('$project_dir/experiment/experiment.yaml'))
    print(d.get('type', 'web-app'))
except: print('web-app')
" 2>/dev/null || echo "web-app"
}

# --- is_web_app_only ---
# Returns 0 (true) if archetype is web-app, 1 (false) otherwise.
# Usage: if is_web_app_only; then ... fi
is_web_app_only() {
  [[ "$(get_archetype)" == "web-app" ]]
}
