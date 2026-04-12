#!/usr/bin/env bash
# init-context.sh — Creates a skill's context file with base schema + optional extra fields.
# Usage: bash .claude/scripts/init-context.sh <skill> [extra_json]
# Examples:
#   bash .claude/scripts/init-context.sh solve
#   bash .claude/scripts/init-context.sh change '{"preliminary_type":null,"affected_areas":null,"solve_depth":null}'
#   bash .claude/scripts/init-context.sh iterate-cross @.runs/_iterate-cross-extra.json
# Companion to advance-state.sh which updates completed_states after each state passes.
set -euo pipefail

SKILL="${1:-}"
EXTRA="${2:-}"

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

# File-reference: @path reads extra JSON from file (resolve relative to PROJECT_DIR)
if [[ -n "$EXTRA" && "$EXTRA" == @* ]]; then
  EXTRA_FILE="${EXTRA#@}"
  [[ "$EXTRA_FILE" != /* ]] && EXTRA_FILE="$PROJECT_DIR/$EXTRA_FILE"
  if [[ ! -f "$EXTRA_FILE" ]]; then
    echo "ERROR: init-context.sh — extra file not found: $EXTRA_FILE" >&2
    exit 1
  fi
  EXTRA=$(cat "$EXTRA_FILE")
fi
CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"

# --- Arg validation ---
if [[ -z "$SKILL" ]]; then
  echo "ERROR: init-context.sh — skill name required" >&2
  echo "Usage: bash .claude/scripts/init-context.sh <skill> [extra_json]" >&2
  exit 1
fi

# --- State-reset guard + identity check ---
if [[ -f "$CTX" ]]; then
  GUARD=$(python3 -c "
import json
d = json.load(open('$CTX'))
has_rid = bool(d.get('run_id', ''))
if has_rid:
    print('has_identity')
else:
    cs = d.get('completed_states', [])
    print('block' if len(cs) > 1 else 'no_identity')
" 2>/dev/null || echo "no_identity")
  if [[ "$GUARD" == "block" ]]; then
    echo "ERROR: init-context.sh — $CTX exists with multiple completed states but no run_id (corrupt state). Delete it manually to re-initialize." >&2
    exit 1
  fi
  if [[ "$GUARD" == "has_identity" ]]; then
    if [[ -z "$EXTRA" || "$EXTRA" == "{}" ]]; then
      # Already initialized, nothing to merge — skip
      echo "INFO: init-context.sh — $CTX already has run_id, skipping" >&2
      exit 0
    else
      # Merge extra fields into existing context, protecting base infrastructure fields
      printf '%s' "$EXTRA" | python3 -c "
import json, sys
ctx = json.load(open('$CTX'))
extra = json.loads(sys.stdin.read())
protected = {'branch', 'timestamp', 'run_id'}
for k, v in extra.items():
    if k not in protected:
        ctx[k] = v
json.dump(ctx, open('$CTX', 'w'))
"
      exit 0
    fi
  fi
  # no_identity — fall through to create (overwrite stub with canonical context)
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
{"skill":"$SKILL","branch":"$BRANCH","timestamp":"$TS","run_id":"$SKILL-$TS","completed_states":[]}
CTXEOF
else
  # Merge base + extra via python3 (extra passed through stdin to avoid shell quoting issues)
  printf '%s' "$EXTRA" | python3 -c "
import json, sys
base = {'skill': '$SKILL', 'branch': '$BRANCH', 'timestamp': '$TS', 'run_id': '$SKILL-$TS', 'completed_states': []}
extra = json.loads(sys.stdin.read())
base.update(extra)
json.dump(base, open('$CTX', 'w'))
"
fi
