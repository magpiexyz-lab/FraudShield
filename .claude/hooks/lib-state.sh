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
# Reads states array from skill.yaml for a skill.
# Handles mode-qualified names (iterate-check → iterate dir, check mode).
# Returns space-separated list of state IDs. Empty string if skill.yaml missing.
# Usage: REQUIRED=$(get_required_states "bootstrap")
get_required_states() {
  local skill="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  # Map mode-qualified skill names to directory + mode
  local skill_dir="$skill" mode=""
  case "$skill" in
    iterate-check) skill_dir="iterate"; mode="check" ;;
    iterate-cross) skill_dir="iterate"; mode="cross" ;;
  esac
  local skill_yaml="$project_dir/.claude/skills/$skill_dir/skill.yaml"
  [[ ! -f "$skill_yaml" ]] && { echo ""; return; }
  python3 -c "
import re
text = open('$skill_yaml').read()
mode = '$mode'
if mode:
    # Parse modes.<mode>.states
    mp = re.search(r'%s:\s*\n\s+.*?states:\s*\[([^\]]+)\]' % mode, text, re.DOTALL)
    if mp:
        states = [s.strip().strip('\"').strip(\"'\") for s in mp.group(1).split(',')]
        print(' '.join(states))
    else:
        print('')
else:
    m = re.search(r'^states:\s*\[([^\]]+)\]', text, re.MULTILINE)
    if m:
        states = [s.strip().strip('\"').strip(\"'\") for s in m.group(1).split(',')]
        print(' '.join(states))
else:
    print('')
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

# --- _detect_skill_for_branch_impl ---
# Internal: shared implementation for detect_active/detect_skill.
# Args: <branch> <include_completed>
#   include_completed="true"  → return any matching context (active or completed)
#   include_completed="false" → skip contexts with completed: true
_detect_skill_for_branch_impl() {
  local branch="$1"
  local include_completed="$2"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  python3 -c "
import json, glob, os
branch = '$branch'
project = '$project_dir'
include_completed = ('$include_completed' == 'true')
best_skill = ''
best_ts = ''
for f in glob.glob(os.path.join(project, '.runs', '*-context.json')):
    if 'epilogue-context' in f:
        continue
    try:
        d = json.load(open(f))
        if d.get('branch') != branch:
            continue
        if not include_completed and d.get('completed'):
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

# --- detect_active_skill_for_branch ---
# Scans *-context.json files, matches branch, returns skill name.
# Returns "" if no matching context found.
# Ignores epilogue-context.json and completed contexts.
# Usage: SKILL=$(detect_active_skill_for_branch "$BRANCH")
detect_active_skill_for_branch() {
  _detect_skill_for_branch_impl "$1" "false"
}

# --- detect_skill_for_branch ---
# Like detect_active_skill_for_branch but does NOT filter completed contexts.
# Use for PR gates where the skill has already finished all states and
# advance-state.sh has set completed: true before PR creation.
# Returns "" if no matching context found.
# Usage: SKILL=$(detect_skill_for_branch "$BRANCH")
detect_skill_for_branch() {
  _detect_skill_for_branch_impl "$1" "true"
}

# --- get_observation_gate ---
# Derives observation gate metadata from skill.yaml for a skill.
# Fields: gate_mechanism, gate_artifacts, pr_checks, strategy.
# Skills with observation section in skill.yaml use explicit config;
# skills without default to postcondition-only.
# Usage: MECH=$(get_observation_gate "upgrade" "gate_mechanism")
get_observation_gate() {
  local skill="$1"
  local field="$2"
  # Map mode-qualified skill names to directory
  local skill_dir="$skill"
  case "$skill" in
    iterate-check) skill_dir="iterate" ;;
    iterate-cross) skill_dir="iterate" ;;
  esac
  local skill_yaml="${CLAUDE_PROJECT_DIR:-.}/.claude/skills/$skill_dir/skill.yaml"
  [[ ! -f "$skill_yaml" ]] && { echo ""; return; }
  python3 -c "
import re
text = open('$skill_yaml').read()
field = '$field'

# Parse observation section from skill.yaml
obs = {}
in_obs = False
for line in text.split('\n'):
    if line.startswith('observation:'):
        in_obs = True
        continue
    if in_obs:
        if line and not line[0].isspace():
            break  # New top-level key
        m = re.match(r'\s+(\w+):\s*(.*)', line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if val.startswith('['):
                items = [s.strip().strip('\"').strip(\"'\") for s in val.strip('[]').split(',') if s.strip()]
                obs[key] = items
            else:
                obs[key] = val

# Map field names to skill.yaml observation keys
if field == 'gate_mechanism':
    print(obs.get('gate', ''))
elif field == 'gate_artifacts':
    arts = obs.get('artifacts', [])
    print(' '.join(arts) if isinstance(arts, list) else arts)
elif field == 'pr_checks':
    checks = obs.get('pr_checks', [])
    print(' '.join(checks) if isinstance(checks, list) else checks)
elif field == 'strategy':
    has_branch = bool(re.search(r'^branch:', text, re.MULTILINE))
    has_embed = bool(re.search(r'skill:\s*verify', text))
    if has_embed: print('verify-embedded')
    elif has_branch: print('A')
    else: print('B')
else:
    print('')
" 2>/dev/null || echo ""
}

# --- parse_advance_state_args ---
# Parse advance-state.sh arguments from a command string.
# Sets SKILL and STATE_ID globals. Expects $COMMAND to be set.
parse_advance_state_args() {
  # Intentionally global — callers read SKILL and STATE_ID after invoking this function
  # shellcheck disable=SC2034
  SKILL=$(echo "$COMMAND" | grep -oE 'advance-state\.sh[[:space:]]+([a-z-]+)' | awk '{print $NF}' || echo "")
  # shellcheck disable=SC2034
  STATE_ID=$(echo "$COMMAND" | grep -oE 'advance-state\.sh[[:space:]]+[a-z-]+[[:space:]]+([0-9a-z_]+)' | awk '{print $NF}' || echo "")
}

# --- get_archetype ---
# Reads archetype from context JSON (matching hook patterns) or experiment.yaml.
# Returns "web-app" if absent or on error.
# Usage: ARCH=$(get_archetype)
get_archetype() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  # 1. Try context JSON files
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
