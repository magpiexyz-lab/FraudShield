#!/usr/bin/env bash
# gate-artifact-write-gate.sh — PreToolUse hook for Write/Edit on gate-readable
# .runs/*.json paths declared in .claude/patterns/gate-readable-artifacts-canonical.json.
#
# GRAIM v2 Slice 6 — MODE=deny (PR2 flip).
#
# Why a hook on Write/Edit specifically:
#   The canonical writer .claude/scripts/lib/write-gate-artifact.sh uses
#   `python3 -c '...' > path` (Bash tool), not Write/Edit. So this hook
#   ONLY fires on direct Write/Edit attempts that bypass the canonical writer
#   — exactly the failure mode #1198 demonstrated for observation-enforcement.json.
#
# Mode flip log:
#   PR1 (#1215): MODE=warn — friction log only, write allowed
#   PR2 (this PR): MODE=deny — block direct Write/Edit on canonical paths
#
#   Empirical justification for fast-track flip: 0 friction entries logged in
#   .runs/hook-friction.jsonl from gate-artifact-write-gate during the entire
#   soak window between PR1 merge and PR2 (multiple slice implementer subagents
#   running real Write/Edit traffic). The canonical-paths whitelist is exact
#   (112 string-equal entries, not glob), and all legitimate writers were
#   audited in Slices 0/3/3.1/3.2 — the soak's "discover unknown legitimate
#   writers" purpose was satisfied empirically without time accumulation.
#
# Escape hatch: any caller hitting a false positive can downgrade per-invocation
# via env var GATE_ARTIFACT_WRITE_GATE_MODE=warn (preserved from PR1). File an
# issue with the friction log entry so the writer can be migrated to canonical.

set -euo pipefail

MODE="${GATE_ARTIFACT_WRITE_GATE_MODE:-deny}"

# shellcheck source=/dev/null
source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")

# Fast-path: no path → allow.
[ -z "$FILE_PATH" ] && exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
MANIFEST_PATH="$PROJECT_DIR/.claude/patterns/gate-readable-artifacts-canonical.json"

# Manifest missing → fail-open (don't block writes if the manifest itself is gone).
[ ! -f "$MANIFEST_PATH" ] && exit 0

# Normalize FILE_PATH to repo-relative (strip $PROJECT_DIR prefix if present).
TARGET_REL="${FILE_PATH#"$PROJECT_DIR"/}"

# Match against manifest. Python keeps the JSON parse robust and the comparison
# exact (no glob/regex surprises).
IS_GATE_READABLE=$(MANIFEST="$MANIFEST_PATH" TARGET="$TARGET_REL" python3 -c "
import json, os, sys
try:
    m = json.load(open(os.environ['MANIFEST']))
    declared = {a['path'] for a in m.get('artifacts', [])}
    print('1' if os.environ['TARGET'] in declared else '0')
except Exception:
    print('0')
" 2>/dev/null || echo "0")

if [ "$IS_GATE_READABLE" != "1" ]; then
  exit 0  # not a gate-readable artifact
fi

# At this point, the Write/Edit target IS a gate-readable artifact. Apply mode.
MSG_WARN="Direct Write/Edit on gate-readable artifact '$TARGET_REL' (use bash .claude/scripts/lib/write-gate-artifact.sh — GRAIM v2 C1)."
MSG_DENY="DENIED: direct Write/Edit on gate-readable .runs path '$TARGET_REL' is forbidden. Use bash .claude/scripts/lib/write-gate-artifact.sh (GRAIM v2 C1). See .claude/patterns/agent-output-contract.md § Canonical Writer Policy."

case "$MODE" in
  warn)
    # Friction log only; allow the write.
    _write_hook_friction "$MSG_WARN"
    exit 0
    ;;
  deny)
    # deny() writes friction + stderr + exit 2 (canonical hook block).
    deny "$MSG_DENY"
    ;;
  *)
    echo "WARN: gate-artifact-write-gate.sh — unknown MODE=$MODE; defaulting to allow" >&2
    exit 0
    ;;
esac
