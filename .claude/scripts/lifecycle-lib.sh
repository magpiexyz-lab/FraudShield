#!/usr/bin/env bash
# lifecycle-lib.sh — Shared functions for lifecycle scripts.
# Facade: sourced by lifecycle-finalize.sh, lifecycle-next.sh, advance-state.sh,
# and state-completion-gate.sh. Provides unified context path, registry key,
# and skill directory resolution with mode awareness.
#
# Requires: caller sets PROJECT_DIR before calling any function.

# --- resolve_context_path <skill> [manifest_path] ---
# Outputs the full context file path to stdout.
# - verify → .runs/verify-context.json
# - manifest with active_mode (non-empty, non-"default") → .runs/{skill}-{mode}-context.json
# - fallback → .runs/{skill}-context.json
resolve_context_path() {
  local skill="$1"
  local manifest="${2:-}"

  if [[ "$skill" == "verify" ]]; then
    echo "$PROJECT_DIR/.runs/verify-context.json"
    return
  fi

  if [[ -n "$manifest" && -f "$manifest" ]]; then
    local ctx_skill
    ctx_skill=$(python3 -c "
import json
m=json.load(open('$manifest'))
am=m.get('active_mode','')
sk='$skill'
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$skill")
    echo "$PROJECT_DIR/.runs/${ctx_skill}-context.json"
  else
    echo "$PROJECT_DIR/.runs/${skill}-context.json"
  fi
}

# --- resolve_registry_key <skill> [manifest_path] ---
# Outputs the state-registry.json lookup key to stdout.
# - manifest with active_mode (non-empty, non-"default") → {skill}-{mode}
# - fallback → {skill}
resolve_registry_key() {
  local skill="$1"
  local manifest="${2:-}"

  if [[ -n "$manifest" && -f "$manifest" ]]; then
    python3 -c "
import json
m=json.load(open('$manifest'))
am=m.get('active_mode','')
sk='$skill'
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$skill"
  else
    echo "$skill"
  fi
}

# --- resolve_skill_dir <skill> ---
# Outputs "{directory} {mode}" or just "{directory}" to stdout.
# Maps mode-qualified skill names to their .claude/skills/ directory and mode.
# - iterate-check → iterate check
# - iterate-cross → iterate cross
# - fallback → {skill}
resolve_skill_dir() {
  local skill="$1"
  case "$skill" in
    iterate-check) echo "iterate check" ;;
    iterate-cross) echo "iterate cross" ;;
    *) echo "$skill" ;;
  esac
}
