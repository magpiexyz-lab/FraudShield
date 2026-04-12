#!/usr/bin/env bash
# skill-commit-gate.sh — Universal PreToolUse hook for Bash (git commit).
# Framework defaults (postconditions, BLOCK verdicts, completion) +
# convention gates at .claude/skills/<skill>/gates/commit.sh.
# Replaces: change-commit-gate.sh + bootstrap-commit-gate.sh (PR 5, v2 migration step 5/8).

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# If the command doesn't contain `git commit`, allow it
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

BRANCH=$(get_branch)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# ── Detect active skill for this branch ──
ACTIVE_SKILL=$(detect_active_skill_for_branch "$BRANCH")

if [[ -z "$ACTIVE_SKILL" ]]; then
  exit 0
fi

# ── Load manifest ──
MANIFEST="$PROJECT_DIR/.runs/${ACTIVE_SKILL}-manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  # No manifest = no active skill lifecycle — allow
  exit 0
fi

# ── Skills with commit enforcement handled elsewhere ──
# /upgrade commits are allowed here — observation enforced by observe-commit-gate.sh
# (matches old change-commit-gate.sh behavior)
if [[ "$ACTIVE_SKILL" == "upgrade" ]]; then
  exit 0
fi

# ── MANIFEST PATH: Framework defaults ──
CTX="$PROJECT_DIR/.runs/${ACTIVE_SKILL}-context.json"
# Use verify-context.json for verify skill
if [[ "$ACTIVE_SKILL" == "verify" ]]; then
  CTX="$PROJECT_DIR/.runs/verify-context.json"
fi

ERRORS=()

# Framework default 1: Re-run postconditions
rerun_postconditions "$ACTIVE_SKILL"

# Framework default 2: BLOCK verdict check
check_block_verdicts

# Framework default 3: State completion check
check_skill_completion "$ACTIVE_SKILL" "$CTX"

# ── Convention gate: .claude/skills/<skill>/gates/commit.sh ──
GATE_SCRIPT="$PROJECT_DIR/.claude/skills/$ACTIVE_SKILL/gates/commit.sh"

if [[ -f "$GATE_SCRIPT" ]]; then
  export PAYLOAD SKILL="$ACTIVE_SKILL" PROJECT_DIR BRANCH COMMAND
  GATE_OUTPUT=$(bash "$GATE_SCRIPT" 2>&1) || {
    [[ -n "$GATE_OUTPUT" ]] && ERRORS+=("$GATE_OUTPUT")
  }
fi

# ── Deny or allow ──
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "Commit blocked ($ACTIVE_SKILL): " "Complete prerequisite checks before committing."
fi

exit 0
