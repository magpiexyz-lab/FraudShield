#!/usr/bin/env bash
# trace-write-guard.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks Bash commands that write to agent-spawn-log.jsonl.
# The spawn-log is hook-managed: only skill-agent-gate.sh (a PreToolUse:Agent
# hook) may write to it. Hook execution does not trigger PreToolUse hooks,
# so the gate's own writes pass through while LLM-initiated Bash writes are
# caught here.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# Fast-path: no mention of spawn-log → allow
case "$COMMAND" in
  *agent-spawn-log*) ;;
  *) exit 0 ;;
esac

# Allow the controlled recovery trace script
case "$COMMAND" in
  *write-recovery-trace.sh*) exit 0 ;;
esac

# Block writes targeting spawn-log (redirects, python open, copy/move)
if echo "$COMMAND" | grep -qE '(>|>>|tee |cp |mv ).*agent-spawn-log'; then
  deny "Trace write guard: agent-spawn-log.jsonl is hook-managed. Only skill-agent-gate.sh may write to it."
fi
if echo "$COMMAND" | grep -qE 'open\(.*agent-spawn-log'; then
  deny "Trace write guard: agent-spawn-log.jsonl is hook-managed. Only skill-agent-gate.sh may write to it."
fi

exit 0
