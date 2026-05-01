#!/usr/bin/env bash
# clean-stale-worktrees.sh — Remove >24h stale skill worktrees.
#
# Lifts the inline pattern previously in .claude/commands/change.md (24h-age cleanup)
# into a shared helper so /resolve, /solve, /change all benefit. Adds an active-session
# guard: skips any worktree whose .runs/<prefix>-context.json has completed:false.
#
# Uses `git worktree list --porcelain` (registered worktrees only) instead of a
# filesystem glob to avoid removing user-created directories that happen to live
# under .claude/worktrees/.
#
# Argument: prefix (e.g., "solve", "resolve", "change"). Required.
# Behavior: silent on no-op; warnings on stderr.
set -euo pipefail
PREFIX="${1:-}"
[ -z "$PREFIX" ] && exit 0

NOW=$(date +%s)

for wt in $(git worktree list --porcelain 2>/dev/null | awk '/^worktree / {print $2}' | grep "/.claude/worktrees/${PREFIX}-" || true); do
  CTX="${wt}/.runs/${PREFIX}-context.json"
  # Active-session guard: skip if context exists and is in-flight (completed:false).
  if [ -f "$CTX" ] && python3 -c "import json,sys; sys.exit(0 if json.load(open('$CTX')).get('completed') is False else 1)" 2>/dev/null; then
    continue
  fi
  MTIME=$(stat -f %m "$wt" 2>/dev/null || stat -c %Y "$wt" 2>/dev/null || echo 0)
  if [ "$MTIME" -gt 0 ] && [ $((NOW - MTIME)) -gt 86400 ]; then
    git worktree remove --force "$wt" 2>/dev/null || true
  fi
done
