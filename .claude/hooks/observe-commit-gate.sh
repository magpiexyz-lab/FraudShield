#!/usr/bin/env bash
# observe-commit-gate.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks final skill commits unless observation epilogue has been performed.
# Data-driven: uses *-context.json + skill.yaml observation config
# to determine which skills need observation enforcement.
# Skills that embed /verify (change, distribute) are exempt —
# verify-report.md proves STATE 6 auto-observe ran.
# Bootstrap uses Strategy A (own observation in state-18).

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# If the command doesn't contain `git commit`, allow it
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

# --- Data-driven skill detection ---
# Scan *-context.json for branch match → get active skill
BRANCH=$(get_branch)
SKILL=$(detect_active_skill_for_branch "$BRANCH")

# No skill context for this branch → non-skill branch, allow
if [[ -z "$SKILL" ]]; then
  exit 0
fi

# Check if this skill uses commit-gate enforcement
GATE_MECH=$(get_observation_gate "$SKILL" "gate_mechanism")
if [[ "$GATE_MECH" != "commit-pr-gate" ]]; then
  exit 0  # postcondition-only skills don't need commit gate
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

# If observe-result.json exists, check verdict consistency then allow
if [[ -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
  # Verdict consistency invariant: non-empty diffs + "clean" + Strategy A = violation
  ERRORS=()
  check_verdict_consistency "$SKILL"
  if [[ ${#ERRORS[@]} -gt 0 ]]; then
    deny_errors "Observation integrity check failed: " "Re-run the skill epilogue to spawn the observer."
  fi
  exit 0
fi

# No observation evidence — check state completion for specific feedback
ERRORS=()
check_skill_completion "$SKILL" "$PROJECT_DIR/.runs/${SKILL}-context.json"
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "Commit blocked: " "Complete all required states before final commit."
fi

# No observation evidence found — deny
deny "Observation not performed for /$SKILL. Run the skill epilogue (.claude/patterns/skill-epilogue.md) before the final commit. This ensures template-level issues are detected and filed."
