#!/usr/bin/env bash
# fix-ledger-write-guard.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks arbitrary Bash writes to .runs/fix-ledger.jsonl and .runs/fix-log.md.
#
# AOC v1 FLS v1 runtime guard. Complements the static R2 coherence rule
# (aoc-fix-ledger-ownership in template-coherence-rules.json) by blocking
# runtime writes the static check cannot see (e.g., ad-hoc shell commands
# issued by the agent during execution).
#
# Only these scripts are allowed to write the gated paths:
#   - .claude/scripts/write-fix-ledger.py  (ledger consolidator + AOC v1.1 --lead-fix)
#   - .claude/scripts/render-fix-log.py    (fix-log renderer)
#
# Benign known-residual (after AOC v1.1 PR5):
#   - echo '# Error Fix Log' > .runs/fix-log.md  (verify STATE 0 init).
#     render-fix-log.py overwrites the file on every state advance, so the
#     transient header line never causes drift. This is the ONLY echo>fix-log
#     pattern retained.
#
# Removed by AOC v1.1 PR5 (migrated to write-fix-ledger.py --lead-fix):
#   - echo 'WARN (e2e-config)...' >> .runs/fix-log.md  (now: --lead-fix --severity warn)
#   - echo 'Fix (e2e)...' >> .runs/fix-log.md           (now: --lead-fix)
#   - echo 'Fix (e2e-config)...' >> .runs/fix-log.md   (now: --lead-fix)
#   - echo 'Fix (spec)...' >> .runs/fix-log.md          (now: --lead-fix)
#
# ORDER matters: chain-delimiter / raw-write checks run BEFORE the
# allowed-writer short-circuit, so a sanctioned script chained with a forged
# raw write cannot bypass detection.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# Fast-path: no mention of the gated paths → allow
case "$COMMAND" in
  *fix-ledger.jsonl*|*fix-log.md*) ;;
  *) exit 0 ;;
esac

# Normalize fd-to-fd redirects (2>&1, >&1, etc.) — same rationale as
# agent-trace-write-guard.sh.
NORM=$(printf '%s' "$COMMAND" | sed -E 's/[0-9]*>+&[0-9]+//g')

# ── Pre-allow checks (MUST run before allow-writer short-circuit) ──

# Reject chained writes even when one side is a legitimate writer.
# Split on &&/;/| and deny if any segment contains both a gated path and
# a write operator (>, >>, tee, cp, mv). The init-header and e2e-warn
# patterns are explicitly re-allowed below.
if echo "$NORM" | awk '
    BEGIN{RS="[&|;]"}
    /(fix-ledger\.jsonl|fix-log\.md)/ && /(>|>>|tee|cp|mv)/ {
        # Allow STATE 0 init (echo header into fix-log.md via single >).
        if ($0 ~ /echo[[:space:]]+['\''"]?# Error Fix Log/ && $0 ~ />[[:space:]]*\.runs\/fix-log\.md/) next
        # Allow STATE 5 inline warn (echo WARN ... into fix-log.md via >>).
        if ($0 ~ /echo[[:space:]]+['\''"]?WARN/ && $0 ~ />>[[:space:]]*\.runs\/fix-log\.md/) next
        found=1
    }
    END{exit !found}'; then
  deny "Fix-ledger write guard: .runs/fix-ledger.jsonl and .runs/fix-log.md may only be written by write-fix-ledger.py / render-fix-log.py (AOC v1 FLS v1). Direct shell writes are blocked; use the canonical writers."
fi

# Block Python open(...) for write/append on the gated paths.
if echo "$COMMAND" | grep -qE "open\([^)]*\.runs/fix-ledger\.jsonl[^)]*,[[:space:]]*['\"][wa]"; then
  deny "Fix-ledger write guard: python open-for-write on .runs/fix-ledger.jsonl is blocked. Use write-fix-ledger.py (AOC v1 FLS v1)."
fi
if echo "$COMMAND" | grep -qE "open\([^)]*\.runs/fix-log\.md[^)]*,[[:space:]]*['\"][wa]"; then
  deny "Fix-ledger write guard: python open-for-write on .runs/fix-log.md is blocked. Use render-fix-log.py (AOC v1 FLS v1)."
fi

# ── Allow-list short-circuit ──

ALLOWED_REGEX_WRITER='(^|[[:space:]]|&&|;|\|)[[:space:]]*python3?[[:space:]]+[./]*\.?claude/scripts/write-fix-ledger\.py'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_WRITER"; then
  exit 0
fi

ALLOWED_REGEX_RENDERER='(^|[[:space:]]|&&|;|\|)[[:space:]]*python3?[[:space:]]+[./]*\.?claude/scripts/render-fix-log\.py'
if echo "$COMMAND" | grep -qE "$ALLOWED_REGEX_RENDERER"; then
  exit 0
fi

# Benign known-residual: allow STATE 0 header init
# (matches `echo '# Error Fix Log' > .runs/fix-log.md`).
# render-fix-log.py overwrites the file on every state advance, so the
# transient header line never causes drift. This is the only echo>fix-log.md
# pattern retained after AOC v1.1 PR5 migrated STATE 5 inline writes to the
# --lead-fix path.
if echo "$NORM" | grep -qE "echo[[:space:]]+['\"]?# Error Fix Log['\"]?[[:space:]]*>[[:space:]]*\.runs/fix-log\.md"; then
  exit 0
fi

# AOC v1.1 PR5: STATE 5 inline writes (Fix(e2e), Fix(e2e-config), Fix(spec),
# WARN(e2e-config)) are NO LONGER allowlisted. They migrated to
# write-fix-ledger.py --lead-fix [--severity warn]. If you see this hook
# blocking a STATE 5 echo, update the state file to use the lead-fix path
# (state-5-e2e-tests.md was migrated in PR5).

# Allow reads of the gated paths (cat/grep/wc/python3 -c reading, etc.).
# If the command contains a gated path but no write operator, it's a read.
if ! echo "$NORM" | grep -qE '(>|>>|[[:space:]]tee[[:space:]]|[[:space:]]cp[[:space:]]|[[:space:]]mv[[:space:]])[^<]*\.runs/(fix-ledger\.jsonl|fix-log\.md)'; then
  exit 0
fi

# ── Final catch-all: any direct write operator targeting gated paths ──
if echo "$NORM" | grep -qE '(>|>>|[[:space:]]tee[[:space:]]|[[:space:]]cp[[:space:]]|[[:space:]]mv[[:space:]]).*\.runs/(fix-ledger\.jsonl|fix-log\.md)'; then
  deny "Fix-ledger write guard: writes to .runs/fix-ledger.jsonl / .runs/fix-log.md must go through write-fix-ledger.py / render-fix-log.py (AOC v1 FLS v1). Direct shell writes are blocked."
fi

exit 0
