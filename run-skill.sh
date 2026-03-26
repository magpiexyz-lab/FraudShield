#!/usr/bin/env bash
# run-skill.sh — Generic skill orchestration for MVP template.
# Splits skills into multiple claude CLI conversations based on declarative configs.
# Usage: ./run-skill.sh <skill> [args...]
# Env:   RESUME_FROM=<phase_number> to skip earlier phases
set -euo pipefail

SKILL="${1:-}"
shift || true
ARGS="$*"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$PROJECT_DIR/.claude/orchestration/$SKILL.json"
RESUME_FROM="${RESUME_FROM:-0}"

# --- Validation ---
if [[ -z "$SKILL" ]]; then
  echo "Usage: ./run-skill.sh <skill> [args...]"
  echo "Env:   RESUME_FROM=<N> to resume from phase N"
  exit 1
fi

# --- Path A: No orchestration config → direct exec ---
if [[ ! -f "$CONFIG" ]]; then
  echo "[orchestrator] No config for '$SKILL' — running directly"
  exec claude --effort max -- "/$SKILL $ARGS"
fi

# --- Read config metadata ---
eval "$(python3 -c "
import json
config = json.load(open('$CONFIG'))
phases = config['phases']
print(f'PHASE_COUNT={len(phases)}')
single = len(phases) == 1 and phases[0].get('interactive', False)
print(f'SINGLE_INTERACTIVE={1 if single else 0}')
")"

# --- Path B: Single interactive phase → degenerate, direct exec ---
if [[ "$SINGLE_INTERACTIVE" == "1" ]]; then
  echo "[orchestrator] Single interactive phase for '$SKILL' — running directly"
  exec claude --effort max -- "/$SKILL $ARGS"
fi

# --- Path C: Full orchestration loop ---
echo "[orchestrator] Running '$SKILL' with $PHASE_COUNT phases (RESUME_FROM=$RESUME_FROM)"

FIRST_NON_SKIPPED=-1
LAST_COMPLETED=-1

for (( i=0; i<PHASE_COUNT; i++ )); do
  # Skip phases before RESUME_FROM
  if [[ $i -lt $RESUME_FROM ]]; then
    echo "[orchestrator] Skipping phase $i (RESUME_FROM=$RESUME_FROM)"
    continue
  fi

  # Track first non-skipped phase
  [[ $FIRST_NON_SKIPPED -lt 0 ]] && FIRST_NON_SKIPPED=$i

  # Extract phase config
  eval "$(python3 -c "
import json
config = json.load(open('$CONFIG'))
phase = config['phases'][$i]
print(f\"PHASE_NAME={phase['name']}\")
print(f\"PHASE_INTERACTIVE={1 if phase.get('interactive', False) else 0}\")
print(f\"PHASE_BUDGET={phase.get('max_budget', 50)}\")
sr = phase['state_range']
print(f\"STATE_START={sr[0]}\")
print(f\"STATE_END={sr[1]}\")
")"

  echo ""
  echo "================================================================"
  echo "[orchestrator] Phase $((i+1))/$PHASE_COUNT: $PHASE_NAME (states $STATE_START-$STATE_END)"
  echo "================================================================"

  # Write pipeline-phase.json signal file
  python3 -c "
import json, datetime
config = json.load(open('$CONFIG'))
phase = config['phases'][$i]
signal = {
    'skill': '$SKILL',
    'phase': phase['name'],
    'phase_index': $i,
    'total_phases': $PHASE_COUNT,
    'state_range': phase['state_range'],
    'started': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
}
json.dump(signal, open('.claude/pipeline-phase.json', 'w'), indent=2)
"

  # Launch claude
  CLAUDE_EXIT=0
  if [[ "$PHASE_INTERACTIVE" == "1" && $i -eq $FIRST_NON_SKIPPED ]]; then
    # Interactive mode: user gets terminal control
    echo "[orchestrator] Interactive phase — launching terminal session"
    claude --effort max -- "/$SKILL $ARGS" || CLAUDE_EXIT=$?
  else
    # Headless mode: automated execution with budget cap
    SYSTEM_PROMPT="[ORCHESTRATOR] Phase $((i+1))/$PHASE_COUNT ($PHASE_NAME). Read .claude/patterns/checkpoint-resumption.md first. Resume from checkpoint. Execute states $STATE_START-$STATE_END ONLY. Do NOT start from STATE 0. Do NOT re-create context JSON."
    echo "[orchestrator] Headless phase — budget \$$PHASE_BUDGET"
    claude -p \
      --effort max \
      --permission-mode acceptEdits \
      --max-budget-usd "$PHASE_BUDGET" \
      --append-system-prompt "$SYSTEM_PROMPT" \
      -- "Resume /$SKILL from checkpoint" || CLAUDE_EXIT=$?
  fi

  # Check claude exit code
  if [[ $CLAUDE_EXIT -ne 0 ]]; then
    echo "[orchestrator] ERROR: claude exited with code $CLAUDE_EXIT in phase $PHASE_NAME"
    python3 -c "
import json, datetime
state = {
    'skill': '$SKILL',
    'total_phases': $PHASE_COUNT,
    'last_completed_phase': $LAST_COMPLETED,
    'status': 'failed',
    'failed_phase': $i,
    'failure_reason': 'claude_exit_$CLAUDE_EXIT',
    'finished': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
}
json.dump(state, open('.claude/pipeline-state.json', 'w'), indent=2)
"
    exit $CLAUDE_EXIT
  fi

  # Run phase gate (skip if last phase with null gate — phase-gate.py handles null)
  echo "[orchestrator] Running gate check for phase $PHASE_NAME..."
  if ! python3 "$PROJECT_DIR/.claude/scripts/phase-gate.py" "$CONFIG" "$i"; then
    echo "[orchestrator] ERROR: Gate check failed for phase $PHASE_NAME"
    python3 -c "
import json, datetime
state = {
    'skill': '$SKILL',
    'total_phases': $PHASE_COUNT,
    'last_completed_phase': $LAST_COMPLETED,
    'status': 'failed',
    'failed_phase': $i,
    'failure_reason': 'gate',
    'finished': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
}
json.dump(state, open('.claude/pipeline-state.json', 'w'), indent=2)
"
    exit 1
  fi

  echo "[orchestrator] Phase $PHASE_NAME — gate passed ✓"
  LAST_COMPLETED=$i
done

# Write final completion state
python3 -c "
import json, datetime
state = {
    'skill': '$SKILL',
    'total_phases': $PHASE_COUNT,
    'last_completed_phase': $LAST_COMPLETED,
    'status': 'complete',
    'finished': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
}
json.dump(state, open('.claude/pipeline-state.json', 'w'), indent=2)
"

echo ""
echo "[orchestrator] $SKILL completed successfully ($PHASE_COUNT phases)"
