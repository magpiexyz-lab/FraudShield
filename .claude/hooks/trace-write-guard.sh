#!/usr/bin/env bash
# trace-write-guard.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks Bash commands that write to agent-spawn-log.jsonl.
#
# The spawn-log is hook-managed: only skill-agent-gate.sh (a PreToolUse:Agent
# hook) may write to it. Hook execution does not trigger PreToolUse hooks,
# so the gate's own writes pass through while LLM-initiated Bash writes are
# caught here.
#
# Issue #963 fix: this hook no longer whitelists write-recovery-trace.sh
# (that script no longer mutates the spawn-log; it relies on the existing
# skill-agent-gate entry). Detection is also tightened — we inspect
# write-operator patterns rather than trusting any leading command name.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# Fast-path: no mention of spawn-log → allow
case "$COMMAND" in
  *agent-spawn-log*) ;;
  *) exit 0 ;;
esac

# Normalize fd-to-fd redirects (2>&1, >&1, 3>&2, etc.) before write-op
# detection. These are stderr/fd redirection tokens, not file writes — but
# their bare `>` character falsely matches the write-operator regex, and
# their embedded `&` falsely splits the awk chain-record (RS="[&|;]").
# Strip them so both checks see the command without fd tokens. File writes
# (>file, >>file, &>file, >&file GNU extension, tee, cp, mv, dd) are
# preserved intact.
NORM=$(printf '%s' "$COMMAND" | sed -E 's/[0-9]*>+&[0-9]+//g')

# Block shell redirect / file-copy writes to spawn-log (redirects, tee, cp, mv, dd)
if echo "$NORM" | grep -qE '(>|>>|[[:space:]]tee[[:space:]]|[[:space:]]cp[[:space:]]|[[:space:]]mv[[:space:]]|[[:space:]]dd[[:space:]]).*agent-spawn-log'; then
  deny "Trace write guard: agent-spawn-log.jsonl is hook-managed. Only skill-agent-gate.sh may write to it."
fi

# Block Python open(...) for write/append mode
if echo "$COMMAND" | grep -qE "open\([^)]*agent-spawn-log[^)]*,[[:space:]]*['\"][wa]"; then
  deny "Trace write guard: agent-spawn-log.jsonl is hook-managed (Python open-for-write detected)."
fi

# Block chained writes: if the command contains && / ; / | and any segment
# afterwards mentions spawn-log with a write operator, reject. Conservative
# AWK split — splits on any chain delimiter and inspects each segment.
if echo "$NORM" | awk 'BEGIN{RS="[&|;]"} /agent-spawn-log/ && /(>|>>|tee|cp|mv|dd)/ {found=1} END{exit !found}'; then
  deny "Trace write guard: agent-spawn-log.jsonl cannot be written from a chained command segment."
fi

exit 0
