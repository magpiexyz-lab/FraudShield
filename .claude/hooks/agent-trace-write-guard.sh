#!/usr/bin/env bash
# agent-trace-write-guard.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks arbitrary Bash writes to .runs/agent-traces/*.json.
#
# Only these scripts are allowed to write agent traces:
#   - scripts/init-trace.py          (start-of-run stub)
#   - .claude/scripts/write-recovery-trace.sh  (orchestrator recovery path)
#   - .claude/scripts/write-degraded-trace.py  (agent self-degradation path)
#   - .claude/scripts/validate-recovery.sh     (stamps recovery_validated only)
#   - .claude/scripts/migrate-legacy-traces.py (one-shot legacy migration)
#   - .claude/scripts/merge-design-critic-traces.py  (verify state-3b lead-merge)
#
# This is the runtime half of the R2 C7 fix (static test_forgery_surface.py
# handles CI). Together they ensure no new script silently becomes an
# unauthorized writer of agent traces.
#
# Write tool (Write/Edit) writes to agent-traces are handled separately by
# artifact-integrity-gate.sh (schema validation).
#
# ORDER matters: the chain-delimiter / raw-write checks run BEFORE the
# allowed-writer short-circuit, so a sanctioned script invocation chained
# with a forged raw write (`bash write-recovery-trace.sh --reason x ; echo > .runs/agent-traces/forged`)
# cannot bypass detection.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# Fast-path: no mention of agent-traces → allow
case "$COMMAND" in
  *agent-traces*) ;;
  *) exit 0 ;;
esac

# Normalize fd-to-fd redirects (2>&1, >&1, 3>&2, 2>>&1, etc.) before write-op
# detection. These are stderr/fd redirection tokens, not file writes — but
# their bare `>` character falsely matches the write-operator regex below,
# and their embedded `&` falsely splits the awk chain-record (RS="[&|;]").
# Strip them at the source so both checks see the command without fd tokens.
# File writes (>file, >>file, &>file, >&file GNU extension, tee, cp, mv) do
# NOT match the `>+&[digit]` pattern and are preserved intact.
NORM=$(printf '%s' "$COMMAND" | sed -E 's/[0-9]*>+&[0-9]+//g')

# ── Pre-allow checks (MUST run before allow-writer short-circuit) ──

# Reject chained writes even when one side is a legitimate writer.
# Split on &&/;/| and deny if any segment contains both agent-traces/ and
# a write operator (>, >>, tee, cp, mv).
if echo "$NORM" | awk 'BEGIN{RS="[&|;]"} /agent-traces\// && /(>|>>|tee|cp|mv)/ {found=1} END{exit !found}'; then
  deny "Agent trace write guard: agent-traces/*.json cannot be written from a chained command segment (raw write operator detected alongside agent-traces path)."
fi

# Block Python open(...) for write/append on agent-traces
if echo "$COMMAND" | grep -qE "open\([^)]*agent-traces/[^)]*,[[:space:]]*['\"][wa]"; then
  deny "Agent trace write guard: python open-for-write on agent-traces/ is blocked. Use write-recovery-trace.sh or write-degraded-trace.py."
fi

# ── Allow-list short-circuit ──

# Leading-anchor regex: each sanctioned writer must appear at a command
# boundary (start, whitespace, or chain delimiter). Optional `bash ` /
# `python3 ` wrapper permitted.

ALLOWED_REGEX='(^|[[:space:]]|&&|;|\|)[[:space:]]*(bash[[:space:]]+|python3?[[:space:]]+)?[./]*\.?claude/scripts/write-recovery-trace\.sh[[:space:]]'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX"; then
  # write-recovery-trace.sh must include --reason (defense-in-depth with the
  # script's own argument check). Look for --reason before any chain delimiter.
  if echo "$COMMAND" | grep -qE 'write-recovery-trace\.sh[^&|;]*--reason'; then
    exit 0
  else
    deny "Agent trace write guard: write-recovery-trace.sh invocation lacks --reason (required by issue #963 contract)."
  fi
fi

ALLOWED_REGEX_DEGRADED='(^|[[:space:]]|&&|;|\|)[[:space:]]*(bash[[:space:]]+|python3?[[:space:]]+)?[./]*\.?claude/scripts/write-degraded-trace\.py[[:space:]]'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_DEGRADED"; then
  if echo "$COMMAND" | grep -qE 'write-degraded-trace\.py[^&|;]*--reason'; then
    exit 0
  else
    deny "Agent trace write guard: write-degraded-trace.py invocation lacks --reason (required by trace schema)."
  fi
fi

ALLOWED_REGEX_INIT='(^|[[:space:]]|&&|;|\|)[[:space:]]*python3?[[:space:]]+[./]*scripts/init-trace\.py[[:space:]]'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_INIT"; then
  exit 0
fi

# Allow the recovery-validator (read-modify-write on recovery traces only —
# it only stamps recovery_validated:true on existing traces).
ALLOWED_REGEX_VALIDATE='(^|[[:space:]]|&&|;|\|)[[:space:]]*bash[[:space:]]+[./]*\.?claude/scripts/validate-recovery\.sh[[:space:]]'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_VALIDATE"; then
  exit 0
fi

# Allow the legacy-trace migrator (read-modify-write, no new traces created)
ALLOWED_REGEX_MIGRATE='(^|[[:space:]]|&&|;|\|)[[:space:]]*python3?[[:space:]]+[./]*\.?claude/scripts/migrate-legacy-traces\.py'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_MIGRATE"; then
  exit 0
fi

# Allow the official design-critic merge script (lead-merge aggregation at
# verify state-3b — issue #1045 extracted this from an inline python3 -c
# block that tripped the open-for-write regex below).
ALLOWED_REGEX_MERGE_DESIGN_CRITIC='(^|[[:space:]]|&&|;|\|)[[:space:]]*python3?[[:space:]]+[./]*\.?claude/scripts/merge-design-critic-traces\.py'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_MERGE_DESIGN_CRITIC"; then
  exit 0
fi

# ── Final catch-all: any direct write operator targeting agent-traces ──
# Use the fd-redirect-stripped NORM so `cmd 2>&1 > agent-traces/foo.json` still
# denies correctly (on the real `>` that writes the file) but
# `ls agent-traces/ 2>&1` is not falsely flagged.

if echo "$NORM" | grep -qE '(>|>>|[[:space:]]tee[[:space:]]|[[:space:]]cp[[:space:]]|[[:space:]]mv[[:space:]]).*agent-traces/[^[:space:]]+\.json'; then
  deny "Agent trace write guard: .runs/agent-traces/*.json writes must go through init-trace.py / write-recovery-trace.sh / write-degraded-trace.py. Direct shell writes are blocked."
fi

exit 0
