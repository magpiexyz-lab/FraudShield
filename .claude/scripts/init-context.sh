#!/usr/bin/env bash
# init-context.sh — Creates a skill's context file with base schema + optional extra fields.
# Usage: bash .claude/scripts/init-context.sh <skill> [extra_json]
# Examples:
#   bash .claude/scripts/init-context.sh solve
#   bash .claude/scripts/init-context.sh change '{"preliminary_type":null,"affected_areas":null,"solve_depth":null}'
# Companion to advance-state.sh which updates completed_states after each state passes.
set -euo pipefail

SKILL="${1:-}"
EXTRA="${2:-}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"

# --- Arg validation ---
if [[ -z "$SKILL" ]]; then
  echo "ERROR: init-context.sh — skill name required" >&2
  echo "Usage: bash .claude/scripts/init-context.sh <skill> [extra_json]" >&2
  exit 1
fi

# --- State-reset guard ---
if [[ -f "$CTX" ]]; then
  GUARD=$(python3 -c "
import json
d = json.load(open('$CTX'))
cs = d.get('completed_states', [])
print('block' if len(cs) > 1 or (len(cs) == 1 and cs[0] != 0) else 'ok')
" 2>/dev/null || echo "ok")
  if [[ "$GUARD" == "block" ]]; then
    echo "ERROR: init-context.sh — $CTX exists with completed_states beyond [0]. Delete it manually to re-initialize." >&2
    exit 1
  fi
fi

# --- Ensure .runs/ exists ---
mkdir -p "$PROJECT_DIR/.runs"

# --- Generate timestamp (shared for both timestamp and run_id) ---
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BRANCH="$(git branch --show-current)"

# --- Write context file ---
if [[ -z "$EXTRA" || "$EXTRA" == "{}" ]]; then
  # Pure bash — no python3 needed
  cat > "$CTX" << CTXEOF
{"skill":"$SKILL","branch":"$BRANCH","timestamp":"$TS","run_id":"$SKILL-$TS","completed_states":[0]}
CTXEOF
else
  # Merge base + extra via python3 (extra passed through stdin to avoid shell quoting issues)
  printf '%s' "$EXTRA" | python3 -c "
import json, sys
base = {'skill': '$SKILL', 'branch': '$BRANCH', 'timestamp': '$TS', 'run_id': '$SKILL-$TS', 'completed_states': [0]}
extra = json.loads(sys.stdin.read())
base.update(extra)
json.dump(base, open('$CTX', 'w'))
"
fi
