#!/usr/bin/env bash
# observe-commit-gate.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks final /resolve and /review commits unless observation epilogue has been performed.
# Skills that run /verify (bootstrap, change, harden, distribute) are exempt —
# verify-report.md proves STATE 6 auto-observe ran.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# If the command doesn't contain `git commit`, allow it
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

# Only enforce on fix/ branches (/resolve) and chore/review-fixes branches (/review)
BRANCH=$(get_branch)
if [[ ! "$BRANCH" =~ ^fix/ ]] && [[ ! "$BRANCH" =~ ^chore/review-fixes ]]; then
  exit 0
fi

# Allow WIP commits (only enforce on final commits)
if [[ "$COMMAND" != *"Fix #"* ]] && [[ "$COMMAND" != *"Fix \#"* ]] && [[ "$COMMAND" != *"Automated review-fix"* ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# If verify-report.md exists, verify's STATE 6 handled observation — allow
if [[ -f "$PROJECT_DIR/.runs/verify-report.md" ]]; then
  exit 0
fi

# If observe-result.json exists, the skill epilogue ran — allow
if [[ -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
  exit 0
fi

# State completion check — deny with specific feedback before generic observation deny
ERRORS=()
if [[ "$BRANCH" =~ ^fix/ ]]; then
  check_skill_completion "resolve" "$PROJECT_DIR/.runs/resolve-context.json"
fi
if [[ "$BRANCH" =~ ^chore/review-fixes ]]; then
  check_skill_completion "review" "$PROJECT_DIR/.runs/review-context.json"
fi
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "Commit blocked: " "Complete all required states before final commit."
fi

# No observation evidence found — deny
deny "Observation not performed. Run the skill epilogue (.claude/patterns/skill-epilogue.md) before the final commit. This ensures template-level issues are detected and filed."
