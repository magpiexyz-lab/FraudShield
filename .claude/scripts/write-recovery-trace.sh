#!/usr/bin/env bash
# write-recovery-trace.sh — Controlled recovery trace writer.
# Use when an agent genuinely crashed after returning output but before
# writing its trace. Writes both the trace AND a spawn-log entry so the
# universal provenance check in state-completion-gate.sh passes.
#
# Usage: bash .claude/scripts/write-recovery-trace.sh <agent-name> [skill]
set -euo pipefail

AGENT="${1:?Usage: write-recovery-trace.sh <agent-name> [skill]}"
SKILL="${2:-verify}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"
RUN_ID=$(python3 -c "import json;print(json.load(open('$CTX')).get('run_id',''))" 2>/dev/null || echo "")
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Write recovery trace to agent-traces/
mkdir -p "$PROJECT_DIR/.runs/agent-traces"
echo "{\"agent\":\"$AGENT\",\"timestamp\":\"$TS\",\"verdict\":\"recovery\",\"recovery\":true,\"checks_performed\":[\"exhaustion-recovery\"],\"run_id\":\"$RUN_ID\"}" \
  > "$PROJECT_DIR/.runs/agent-traces/$AGENT.json"

# Record in spawn-log so provenance check passes
echo "{\"agent\":\"$AGENT\",\"skill\":\"$SKILL\",\"run_id\":\"$RUN_ID\",\"timestamp\":\"$TS\",\"hook\":\"recovery-script\"}" \
  >> "$PROJECT_DIR/.runs/agent-spawn-log.jsonl"

echo "Recovery trace written for $AGENT"
