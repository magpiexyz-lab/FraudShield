#!/usr/bin/env bash
# state-completion-gate.sh — Claude Code PreToolUse hook for Bash commands.
# Validates state postconditions before allowing completed_states updates.
# Works with advance-state.sh: when the LLM marks a state complete, this hook
# checks that the state's postcondition artifacts actually exist on disk.
# Supports all skills via per-skill registry in state-registry.json.
set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# Only fire on advance-state.sh calls
if [[ "$COMMAND" != *"advance-state.sh"* ]]; then
  exit 0
fi

# Extract skill name and state identifier from: advance-state.sh <skill> <state>
SKILL=$(echo "$COMMAND" | grep -oE 'advance-state\.sh[[:space:]]+([a-z-]+)' | awk '{print $NF}' || echo "")
STATE_ID=$(echo "$COMMAND" | grep -oE 'advance-state\.sh[[:space:]]+[a-z-]+[[:space:]]+([0-9a-z_]+)' | awk '{print $NF}' || echo "")

if [[ -z "$SKILL" || -z "$STATE_ID" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
REGISTRY="$PROJECT_DIR/.claude/patterns/state-registry.json"

if [[ ! -f "$REGISTRY" ]]; then
  exit 0  # Fail-open if registry missing
fi

# --- BLOCK verdict check: deny state advancement if any gate has BLOCK on this branch ---
VERDICTS_DIR="$PROJECT_DIR/.claude/runs/gate-verdicts"
if [[ -d "$VERDICTS_DIR" ]]; then
  BRANCH=$(get_branch)
  for gf in "$VERDICTS_DIR"/*.json; do
    [[ -f "$gf" ]] || continue
    gv=$(read_json_field "$gf" "verdict")
    [[ "$gv" != "BLOCK" ]] && continue
    gvb=$(read_json_field "$gf" "branch")
    if [[ "$gvb" == "$BRANCH" ]]; then
      gate_id=$(basename "$gf" .json)
      deny "Gate $gate_id has BLOCK verdict. Fix blocking items and re-run gate-keeper before advancing."
    fi
  done
fi

# Look up VERIFY command for this skill + state (nested lookup — keep inline)
# Supports both string format ("test -f ...") and object format ({"verify": "...", "calls": [...]})
ENTRY_DATA=$(python3 -c "
import json
reg = json.load(open('$REGISTRY'))
entry = reg.get('$SKILL', {}).get('$STATE_ID', '')
if isinstance(entry, dict):
    print(entry.get('verify', '') + '\t' + json.dumps(entry.get('calls', [])))
else:
    print(str(entry) + '\t')
" 2>/dev/null || echo "")

VERIFY_CMD=$(printf '%s' "$ENTRY_DATA" | cut -f1)
CALLS_JSON=$(printf '%s' "$ENTRY_DATA" | cut -f2)

# --- Chain check: verify all prior states are in completed_states ---
# This prevents skipping states (e.g., jumping from STATE 0 to STATE 3).
# Uses registry key order as the canonical state sequence.
if [[ "$SKILL" == "verify" ]]; then
  CTX_FILE="$PROJECT_DIR/.claude/runs/verify-context.json"
else
  CTX_FILE="$PROJECT_DIR/.claude/runs/${SKILL}-context.json"
fi

if [[ -f "$CTX_FILE" ]]; then
  CHAIN_RESULT=$(python3 -c "
import json, sys
reg = json.load(open('$REGISTRY'))
ctx = json.load(open('$CTX_FILE'))
cs = [str(s) for s in ctx.get('completed_states', [])]
states = list(reg.get('$SKILL', {}).keys())
cur = '$STATE_ID'
if cur in states:
    idx = states.index(cur)
    missing = [s for s in states[:idx] if s not in cs]
    if missing:
        print(','.join(missing))
" 2>/dev/null || echo "")

  if [[ -n "$CHAIN_RESULT" ]]; then
    deny "State completion gate: $SKILL STATE $STATE_ID — prior states not complete: [$CHAIN_RESULT]. Complete earlier states before advancing."
  fi
fi

# --- Artifact check: run VERIFY command from registry ---
if [[ -z "$VERIFY_CMD" || "$VERIFY_CMD" == "true" ]]; then
  exit 0  # No artifact check for this state (chain check above still enforces order)
fi

# Run the verify command from project root
cd "$PROJECT_DIR"
if ! eval "$VERIFY_CMD" >/dev/null 2>&1; then
  deny "State completion gate: $SKILL STATE $STATE_ID postconditions not met. VERIFY failed: $VERIFY_CMD — complete this state's actions before marking it done."
fi

# --- Calls artifact check: verify each call's artifact exists ---
if [[ -n "$CALLS_JSON" && "$CALLS_JSON" != "[]" ]]; then
  MISSING_ARTIFACTS=$(printf '%s' "$CALLS_JSON" | python3 -c "
import json, os, sys
calls = json.load(sys.stdin)
missing = []
for c in calls:
    art = c.get('artifact', '')
    if art and not os.path.isfile(art):
        missing.append(art + ' (required by ' + c.get('path', '?') + ')')
if missing:
    print('; '.join(missing))
" 2>/dev/null || echo "")

  if [[ -n "$MISSING_ARTIFACTS" ]]; then
    deny "State completion gate: $SKILL STATE $STATE_ID postconditions not met. Missing call artifacts: $MISSING_ARTIFACTS"
  fi
fi

# Postconditions verified — allow
exit 0
