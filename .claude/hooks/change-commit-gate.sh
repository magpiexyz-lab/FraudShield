#!/usr/bin/env bash
# change-commit-gate.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks final change/fix/upgrade commit unless G4 gate passed and
# verify-report.md exists with a passing build.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# If the command doesn't contain `git commit`, allow it
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

# If the current branch is not change/, feat/, fix/, or chore/harden, allow it
BRANCH=$(get_branch)
if [[ ! "$BRANCH" =~ ^(change|feat|fix)/ ]] && [[ ! "$BRANCH" =~ ^chore/(harden|distribute|review) ]]; then
  exit 0
fi

# Exclude bootstrap branches (handled by bootstrap-commit-gate.sh)
if [[ "$BRANCH" =~ ^feat/bootstrap ]]; then
  exit 0
fi

# Handle chore/harden branches — only enforce at final step, require verify-report.md
if [[ "$BRANCH" =~ ^chore/harden ]]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
  PLAN="$PROJECT_DIR/.claude/runs/current-plan.md"
  if [[ -f "$PLAN" ]]; then
    HARDEN_CP=$(python3 -c "
import re
with open('$PLAN') as f:
    content = f.read()
m = re.search(r'checkpoint:\s*(\S+)', content)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")
    if [[ -n "$HARDEN_CP" && "$HARDEN_CP" != "step3-pr" ]]; then
      exit 0  # Not at final step, allow
    fi
  else
    exit 0  # No plan file = not at final step
  fi
  # Final harden commit — require verify-report.md
  REPORT="$PROJECT_DIR/.claude/runs/verify-report.md"
  if [[ ! -f "$REPORT" ]]; then
    deny "Harden commit blocked: verify-report.md missing — run /verify before final commit."
  fi
  exit 0  # verify-report exists, allow
fi

# Handle chore/distribute branches — require verify-report.md before final commit
if [[ "$BRANCH" =~ ^chore/distribute ]]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
  REPORT="$PROJECT_DIR/.claude/runs/verify-report.md"
  if [[ -f "$REPORT" ]]; then
    exit 0  # verify-report exists, allow
  fi
  # Only block at final state (state 7+ completed = ready for verify+commit)
  CTX="$PROJECT_DIR/.claude/runs/distribute-context.json"
  if [[ -f "$CTX" ]]; then
    STATES=$(normalize_states "$CTX")
    AT_FINAL=$([[ " $STATES " == *" 7 "* ]] && echo "yes" || echo "no")
    if [[ "$AT_FINAL" == "yes" ]]; then
      deny "Distribute commit blocked: verify-report.md missing — run verify before final commit."
    fi
  fi
  exit 0
fi

# Handle chore/review branches — require review-complete.json + state completion before final commit
if [[ "$BRANCH" =~ ^chore/review ]]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
  CTX="$PROJECT_DIR/.claude/runs/review-context.json"
  if [[ -f "$CTX" ]]; then
    # State completion check
    ERRORS=()
    check_skill_completion "review" "$CTX"
    if [[ ${#ERRORS[@]} -gt 0 ]]; then
      deny_errors "Review commit blocked: " "Complete all required states first."
    fi
    STATES=$(normalize_states "$CTX")
    AT_FINAL=$([[ " $STATES " == *" 4 "* ]] && echo "yes" || echo "no")
    if [[ "$AT_FINAL" == "yes" && ! -f "$PROJECT_DIR/.claude/runs/review-complete.json" ]]; then
      deny "Review commit blocked: review-complete.json missing — complete review validation first."
    fi
  fi
  exit 0
fi

# Only allow worktree merge commits through unconditionally
if [[ "$COMMAND" == *"Merge implementer"* ]]; then
  exit 0
fi

# Check current-plan.md checkpoint — only enforce on final commit (phase2-step8)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# /resolve epilogue bypass: fix/ branches with observe-result.json skip G4/verify checks.
# /resolve does not produce G4 verdicts or verify-report.md — its observation is handled
# by skill-epilogue.md which writes observe-result.json.
if [[ "$BRANCH" =~ ^fix/ ]] && [[ -f "$PROJECT_DIR/.claude/runs/observe-result.json" ]]; then
  exit 0
fi

PLAN="$PROJECT_DIR/.claude/runs/current-plan.md"

if [[ -f "$PLAN" ]]; then
  CHECKPOINT=$(python3 -c "
import re
with open('$PLAN') as f:
    content = f.read()
m = re.search(r'checkpoint:\s*(\S+)', content)
print(m.group(1) if m else '')
" 2>/dev/null || echo "")
  # Only enforce on final commit (checkpoint at phase2-step8 or later)
  if [[ -n "$CHECKPOINT" && "$CHECKPOINT" != "phase2-step8" ]]; then
    exit 0
  fi
fi

# recover: commits allowed only when a plan exists (proves recovery from valid state)
if [[ "$COMMAND" == *"recover:"* ]]; then
  if [[ ! -f "$PLAN" ]]; then
    deny "recover: commit blocked — no current-plan.md found. Cannot recover without an existing plan."
  fi
  exit 0
fi

# --- Final change commit detected — run gate checks ---

ERRORS=()

# Check 0a: Postcondition re-verification
rerun_postconditions "change"

# Check 0b: BLOCK verdict check
check_block_verdicts

# Check 0c: State completion check
check_skill_completion "change" "$PROJECT_DIR/.claude/runs/change-context.json"

# Check 1: G4 verdict file exists with PASS
VERDICTS_DIR="$PROJECT_DIR/.claude/runs/gate-verdicts"
check_verdict_gates "g4" "$VERDICTS_DIR" "$BRANCH"

# Check 2: verify-report.md exists with passing build
REPORT="$PROJECT_DIR/.claude/runs/verify-report.md"
if [[ ! -f "$REPORT" ]]; then
  ERRORS+=("verify-report.md missing — run /verify before committing")
else
  BUILD_RESULT=$(python3 -c "
import re
with open('$REPORT') as f:
    content = f.read()
if 'Result: pass' in content or 'result: pass' in content:
    print('pass')
else:
    print('unknown')
" 2>/dev/null || echo "unknown")
  if [[ "$BUILD_RESULT" != "pass" ]]; then
    ERRORS+=("verify-report.md does not show build pass")
  fi
fi

# If any check failed, deny the commit
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "Change commit blocked: " "Complete G4 gate and verification before final commit."
fi

# All checks passed — allow
exit 0
