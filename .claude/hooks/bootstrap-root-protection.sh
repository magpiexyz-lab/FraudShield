#!/usr/bin/env bash
# bootstrap-root-protection.sh — Claude Code PreToolUse hook for Write/Edit.
# Blocks writes to protected root files during bootstrap Phase B.
# Protected files: layout.tsx, not-found.tsx, error.tsx, globals.css

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

FILE_PATH=$(read_payload_field "tool_input.file_path")

# Only care about protected root files
case "$FILE_PATH" in
  */src/app/layout.tsx|*/src/app/not-found.tsx|*/src/app/error.tsx|*/src/app/globals.css)
    ;;
  *)
    exit 0
    ;;
esac

# If the current branch is not feat/bootstrap*, allow
BRANCH=$(get_branch)
if [[ "$BRANCH" != "feat/bootstrap" ]] && [[ ! "$BRANCH" =~ ^feat/bootstrap-[0-9]+$ ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
VERDICTS_DIR="$PROJECT_DIR/.runs/gate-verdicts"

# Condition: BG1 passed AND BG2 has NOT passed AND Phase A sentinel exists
# This means we are in Phase B — root files are protected
if [[ ! -f "$VERDICTS_DIR/bg1.json" ]]; then
  exit 0
fi

BG1_VERDICT=$(read_json_field "$VERDICTS_DIR/bg1.json" "verdict")
if [[ "$BG1_VERDICT" != "PASS" ]]; then
  exit 0
fi

# If BG2 already exists, Phase B is over — allow
if [[ -f "$VERDICTS_DIR/bg2.json" ]]; then
  exit 0
fi

# If Phase A sentinel doesn't exist, Phase A hasn't completed — allow
if [[ ! -f "$VERDICTS_DIR/phase-a-sentinel.json" ]]; then
  exit 0
fi

# All conditions met: we are in Phase B, root files are protected
BASENAME=$(basename "$FILE_PATH")
deny "Bootstrap root protection: '$BASENAME' is a Phase A file and cannot be modified during Phase B. These files were created by the lead before fan-out and must not be overwritten by subagents."
