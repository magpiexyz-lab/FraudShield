#!/usr/bin/env bash
# write.sh — Convention gate for /bootstrap write protection.
# Blocks writes to protected root files during bootstrap Phase B.
# Protected files: layout.tsx, not-found.tsx, error.tsx, globals.css
#
# Extracted from bootstrap-root-protection.sh (bootstrap-specific logic only).
# Called by: skill-write-gate.sh (PR 5) after framework checks pass.
# NOT called yet — created in PR 4c, enabled in PR 5.
set -euo pipefail

source "$(dirname "$0")/../../../hooks/lib.sh"

# Accept env vars (convention gate protocol)
FILE_PATH="${FILE_PATH:-}"
PROJECT_DIR="${PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}"

# Only care about protected root files
case "$FILE_PATH" in
  */src/app/layout.tsx|*/src/app/not-found.tsx|*/src/app/error.tsx|*/src/app/globals.css)
    ;;
  *)
    exit 0
    ;;
esac

VERDICTS_DIR="$PROJECT_DIR/.runs/gate-verdicts"

# Phase B detection: BG1 PASS + BG2 absent + phase-a-sentinel present
if [[ ! -f "$VERDICTS_DIR/bg1.json" ]]; then exit 0; fi

BG1_VERDICT=$(read_json_field "$VERDICTS_DIR/bg1.json" "verdict")
if [[ "$BG1_VERDICT" != "PASS" ]]; then exit 0; fi

# If BG2 already exists, Phase B is over — allow
if [[ -f "$VERDICTS_DIR/bg2.json" ]]; then exit 0; fi

# If Phase A sentinel doesn't exist, Phase A hasn't completed — allow
if [[ ! -f "$VERDICTS_DIR/phase-a-sentinel.json" ]]; then exit 0; fi

# All conditions met: Phase B, root files are protected
BASENAME=$(basename "$FILE_PATH")
deny "Bootstrap root protection: '$BASENAME' is a Phase A file and cannot be modified during Phase B. These files were created by the lead before fan-out and must not be overwritten by subagents."
