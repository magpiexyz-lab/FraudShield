#!/usr/bin/env bash
# write-recovery-trace.sh — Controlled recovery trace writer.
# Use ONLY when an agent genuinely crashed after being spawned but before
# writing its completion trace. Writes the trace only — does NOT append to
# the spawn-log (the skill-agent-gate hook entry is the authoritative spawn
# evidence; recovery reuses it — issue #963 fix removes the forgery surface).
#
# Usage: bash .claude/scripts/write-recovery-trace.sh <agent-name> --reason "<specific cause>"
#
# Preconditions (ALL enforced):
#   1. --reason "<text>" is mandatory
#   2. Target agent is not in agent-registry.json.recovery_forbidden
#      (TYPE C-1: high-risk fixer agents (security-fixer, quality-fixer)
#      cannot be recovered externally; they must self-degrade instead)
#   3. A spawn-log entry from skill-agent-gate exists for <agent> in the
#      current active run_id (proves Agent tool was really invoked — LLM
#      cannot forge this via Bash because skill-agent-gate is a hook)
#   4. Target trace file is absent OR a stub ({status:"started"} no verdict) —
#      refuses to overwrite a potentially legitimate completed trace
set -euo pipefail

AGENT=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reason)
      REASON="${2:-}"
      shift 2
      ;;
    --reason=*)
      REASON="${1#--reason=}"
      shift
      ;;
    --help|-h)
      echo "Usage: $0 <agent-name> --reason \"<specific cause>\""
      exit 0
      ;;
    -*)
      echo "ERROR: write-recovery-trace.sh — unknown flag: $1" >&2
      exit 1
      ;;
    *)
      if [[ -z "$AGENT" ]]; then
        AGENT="$1"
      else
        echo "ERROR: write-recovery-trace.sh — unexpected positional arg: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$AGENT" ]]; then
  echo "ERROR: write-recovery-trace.sh — agent name required" >&2
  echo "Usage: $0 <agent-name> --reason \"<specific cause>\"" >&2
  exit 1
fi

if [[ -z "$REASON" ]]; then
  echo "ERROR: write-recovery-trace.sh — --reason is mandatory (issue #963 precondition)" >&2
  echo "Usage: $0 <agent-name> --reason \"<specific cause>\"" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"
SPAWN_LOG="$PROJECT_DIR/.runs/agent-spawn-log.jsonl"
TRACES_DIR="$PROJECT_DIR/.runs/agent-traces"
REGISTRY="$PROJECT_DIR/.claude/patterns/agent-registry.json"
TARGET_TRACE="$TRACES_DIR/$AGENT.json"

# Resolve active identity (single source of truth for run_id)
# shellcheck source=../hooks/lib.sh
source "$PROJECT_DIR/.claude/hooks/lib.sh"
ACTIVE_IDENTITY="$(resolve_active_identity)"
if [[ -z "$ACTIVE_IDENTITY" ]]; then
  echo "ERROR: write-recovery-trace.sh — no active skill context on current branch; cannot resolve run_id" >&2
  exit 1
fi
IFS=$'\t' read -r ACTIVE_SKILL ACTIVE_RUN_ID _ _ <<< "$ACTIVE_IDENTITY"
if [[ -z "$ACTIVE_RUN_ID" ]]; then
  echo "ERROR: write-recovery-trace.sh — active context has empty run_id" >&2
  exit 1
fi

# Precondition 2: agent must not be in recovery_forbidden
FORBIDDEN=$(AGENT_ENV="$AGENT" REGISTRY_ENV="$REGISTRY" python3 -c "
import json, os
agent = os.environ['AGENT_ENV']
try:
    r = json.load(open(os.environ['REGISTRY_ENV']))
    print('yes' if agent in r.get('recovery_forbidden', []) else 'no')
except:
    print('no')
" 2>/dev/null || echo "no")
if [[ "$FORBIDDEN" == "yes" ]]; then
  echo "ERROR: write-recovery-trace.sh — '$AGENT' is in recovery_forbidden (high-risk fixer)." >&2
  echo "       Recovery is refused for this agent; it must self-degrade via write-degraded-trace.py." >&2
  exit 1
fi

# Precondition 3: spawn-log entry from skill-agent-gate exists for this agent + run_id
SPAWN_INFO=$(AGENT_ENV="$AGENT" RUN_ID_ENV="$ACTIVE_RUN_ID" SPAWN_LOG_ENV="$SPAWN_LOG" python3 -c "
import json, os
agent = os.environ['AGENT_ENV']
run_id = os.environ['RUN_ID_ENV']
path = os.environ['SPAWN_LOG_ENV']
if not os.path.isfile(path):
    print('')
    exit(0)
found = None
with open(path) as f:
    for line in f:
        try:
            e = json.loads(line)
        except:
            continue
        if e.get('agent') == agent and e.get('run_id') == run_id and e.get('hook') == 'skill-agent-gate':
            found = e
            break
if found is None:
    print('')
else:
    print(json.dumps({'spawn_index': found.get('spawn_index'), 'head_sha': found.get('head_sha', '')}))
" 2>/dev/null || echo "")
if [[ -z "$SPAWN_INFO" ]]; then
  echo "ERROR: write-recovery-trace.sh — no skill-agent-gate spawn-log entry for '$AGENT' in run_id=$ACTIVE_RUN_ID" >&2
  echo "       Recovery requires the Agent tool to have actually been invoked." >&2
  exit 1
fi

# Precondition 4: target trace absent OR a stub
if [[ -f "$TARGET_TRACE" ]]; then
  TRACE_STATE=$(TARGET_ENV="$TARGET_TRACE" python3 -c "
import json, os
try:
    d = json.load(open(os.environ['TARGET_ENV']))
    has_verdict = 'verdict' in d
    status = d.get('status', '')
    if status == 'started' and not has_verdict:
        print('stub')
    else:
        print('completed')
except:
    print('error')
" 2>/dev/null || echo "error")
  if [[ "$TRACE_STATE" != "stub" ]]; then
    echo "ERROR: write-recovery-trace.sh — target trace at $TARGET_TRACE is not a stub (has verdict or malformed)" >&2
    echo "       Refusing to overwrite a potentially legitimate completed trace." >&2
    exit 1
  fi
fi

# All preconditions met — write recovery trace
mkdir -p "$TRACES_DIR"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

SPAWN_INDEX=$(echo "$SPAWN_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('spawn_index', ''))")
HEAD_SHA=$(echo "$SPAWN_INFO" | python3 -c "import json,sys; print(json.load(sys.stdin).get('head_sha', ''))")

AGENT_ENV="$AGENT" TS_ENV="$TS" REASON_ENV="$REASON" RUN_ID_ENV="$ACTIVE_RUN_ID" \
SKILL_ENV="$ACTIVE_SKILL" SPAWN_SHA_ENV="$HEAD_SHA" SPAWN_IDX_ENV="$SPAWN_INDEX" \
TARGET_ENV="$TARGET_TRACE" python3 - << 'PYEOF'
import json, os
trace = {
    'agent': os.environ['AGENT_ENV'],
    'timestamp': os.environ['TS_ENV'],
    'status': 'abandoned',
    'verdict': 'recovery',
    'provenance': 'recovery',
    'partial': True,
    'checks_performed': ['exhaustion-recovery'],
    'degraded_reason': os.environ['REASON_ENV'],
    'recovery_reason': os.environ['REASON_ENV'],
    'recovery': True,
    'recovery_validated': False,
    'run_id': os.environ['RUN_ID_ENV'],
    'skill': os.environ['SKILL_ENV'],
    'spawn_sha': os.environ['SPAWN_SHA_ENV'],
    'spawn_index': int(os.environ['SPAWN_IDX_ENV']) if os.environ['SPAWN_IDX_ENV'] else None,
}
json.dump(trace, open(os.environ['TARGET_ENV'], 'w'), indent=2)
PYEOF

echo "Recovery trace written: $TARGET_TRACE (reason: \"$REASON\")"
echo "Note: recovery_validated:false — run .claude/scripts/validate-recovery.sh $AGENT to stamp it true after evidence check."
