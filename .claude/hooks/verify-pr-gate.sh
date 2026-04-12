#!/usr/bin/env bash
# verify-pr-gate.sh — Claude Code PreToolUse hook for Bash commands.
# Blocks `gh pr create` unless verify-report.md passes integrity checks.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# If the command doesn't contain `gh pr create`, allow it
if [[ "$COMMAND" != *"gh pr create"* ]]; then
  exit 0
fi

# --- PR creation detected — run verification checks ---

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
REPORT="$PROJECT_DIR/.runs/verify-report.md"
TRACES_DIR="$PROJECT_DIR/.runs/agent-traces"
ERRORS=()
BRANCH=$(get_branch)

# --- PR check functions ---
# Each function maps to a pr_checks entry in skill.yaml observation config.
# Functions use globals: REPORT, TRACES_DIR, ERRORS, PROJECT_DIR, BRANCH, SKILL.
# FRONTMATTER is set by check_frontmatter and used by subsequent checks.

FRONTMATTER=""

check_frontmatter() {
  if [[ ! -f "$REPORT" ]]; then
    ERRORS+=("verify-report.md not found — run /verify first")
    return
  elif ! head -1 "$REPORT" | grep -q '^---$'; then
    ERRORS+=("verify-report.md missing YAML frontmatter")
    return
  fi
  FRONTMATTER=$(sed -n '2,/^---$/p' "$REPORT" | sed '$d')

  local violation
  violation=$(echo "$FRONTMATTER" | grep 'process_violation: *true' || true)
  if [[ -n "$violation" ]]; then
    ERRORS+=("process_violation is true in verify-report.md — verification agents were skipped")
  fi

  local hard_gate mode
  hard_gate=$(echo "$FRONTMATTER" | grep 'hard_gate_failure: *true' || true)
  mode=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "mode")
  if [[ -n "$hard_gate" && "$mode" != "standalone" ]]; then
    ERRORS+=("hard_gate_failure is true — verification hard gate(s) failed; PR blocked in non-standalone mode")
  fi
}

check_agent_match() {
  [[ ! -f "$REPORT" || -z "$FRONTMATTER" ]] && return
  local expected completed
  expected=$(echo "$FRONTMATTER" | grep 'agents_expected:' | sed 's/agents_expected: *//' | tr -d '[]' | tr ',' '\n' | sed 's/^ *//;/^$/d' | sort)
  completed=$(echo "$FRONTMATTER" | grep 'agents_completed:' | sed 's/agents_completed: *//' | tr -d '[]' | tr ',' '\n' | sed 's/^ *//;/^$/d' | sort)
  if [[ "$expected" != "$completed" ]]; then
    ERRORS+=("agents_expected does not match agents_completed in verify-report.md")
  fi
}

# Manifest-based trace completeness: checks each agent in agents_completed
# has a matching trace file. Exact match: {agent}.json. Per-page glob:
# {agent}-*.json (e.g. design-critic-landing.json). Suffix-named independent
# agents (e.g. design-critic-shared) must have their own agents_completed entry.
check_trace_completeness() {
  [[ ! -f "$REPORT" || -z "$FRONTMATTER" ]] && return
  if [[ ! -d "$TRACES_DIR" ]]; then
    ERRORS+=("Agent traces directory not found at $TRACES_DIR")
    return
  fi

  local agents_str
  agents_str=$(echo "$FRONTMATTER" | grep 'agents_completed:' | \
    sed 's/agents_completed: *//' | tr -d '[]' | tr ',' '\n' | \
    sed 's/^ *//;s/ *$//' | sed '/^$/d')

  while IFS= read -r agent; do
    [[ -z "$agent" ]] && continue
    if [[ -f "$TRACES_DIR/${agent}.json" ]]; then
      continue
    elif ls "$TRACES_DIR/${agent}"-*.json &>/dev/null; then
      continue
    else
      ERRORS+=("Missing trace for agent: $agent")
    fi
  done <<< "$agents_str"
}

check_gate_verdicts_pr() {
  local verdicts_dir="$PROJECT_DIR/.runs/gate-verdicts"
  check_verdict_gates "g4 g5 g6" "$verdicts_dir" "$BRANCH"
}

check_acceptance_criteria() {
  local plan="$PROJECT_DIR/.runs/current-plan.md"
  [[ ! -f "$plan" ]] && return

  local ac_result
  ac_result=$(python3 -c "
import sys, os, json, glob

content = open('$plan').read()
if not content.startswith('---'):
    print('SKIP'); sys.exit(0)
parts = content.split('---', 2)
if len(parts) < 3:
    print('SKIP'); sys.exit(0)

try:
    import yaml
    fm = yaml.safe_load(parts[1])
except ImportError:
    import re
    fm_text = parts[1]
    if 'acceptance_criteria:' not in fm_text:
        print('SKIP'); sys.exit(0)
    acs = []
    for m in re.finditer(r'-\s*id:\s*(\S+)\s*\n\s*behavior:.*?\n\s*verify_method:\s*(\S+)(?:\s*\n\s*test_file:\s*(\S+))?', fm_text):
        ac = {'id': m.group(1), 'verify_method': m.group(2)}
        if m.group(3): ac['test_file'] = m.group(3)
        acs.append(ac)
    fm = {'acceptance_criteria': acs if acs else None}
except Exception:
    print('SKIP'); sys.exit(0)

if not fm or not isinstance(fm, dict):
    print('SKIP'); sys.exit(0)

acs = fm.get('acceptance_criteria', None)
if not acs:
    print('SKIP'); sys.exit(0)

traces_dir = os.path.join('$PROJECT_DIR', '.runs/agent-traces')
errors = []
for ac in acs:
    ac_id = ac.get('id', '?')
    method = ac.get('verify_method', '')
    if method == 'unit-test':
        tf = ac.get('test_file', '')
        if tf and not os.path.exists(os.path.join('$PROJECT_DIR', tf)):
            errors.append(ac_id + ': test_file ' + tf + ' not found')
    elif method == 'behavior-verifier':
        found = False
        for f in glob.glob(os.path.join(traces_dir, 'behavior-verifier-*.json')):
            try:
                d = json.load(open(f))
                checks = d.get('checks_performed', [])
                if any(ac_id in str(c) for c in checks):
                    found = True; break
            except: pass
        if not found:
            errors.append(ac_id + ': no behavior-verifier trace found')

if errors:
    print('FAIL:' + '; '.join(errors))
else:
    print('OK')
" 2>/dev/null || echo "SKIP")

  if [[ "$ac_result" == FAIL:* ]]; then
    ERRORS+=("Acceptance criteria not met: ${ac_result#FAIL:}")
  fi
}

check_review_metrics() {
  local review_file="$PROJECT_DIR/.runs/review-complete.json"
  [[ ! -f "$review_file" ]] && return
  local valid
  valid=$(python3 -c "
import json
d = json.load(open('$review_file'))
if d.get('review_complete') != True:
    print('FAIL: review_complete is not true')
else:
    print('OK')
" 2>/dev/null || echo "SKIP")
  if [[ "$valid" == FAIL:* ]]; then
    ERRORS+=("Review metrics: ${valid#FAIL: }")
  fi
}

# --- Data-driven skill dispatch ---
# Replaces branch-prefix if/elif chain. Skill identity comes from context
# files; check lists come from skill.yaml observation config.
SKILL=$(detect_skill_for_branch "$BRANCH")
if [[ -z "$SKILL" ]]; then
  exit 0  # Not skill-driven — allow PR
fi

GATE_ARTIFACTS=$(get_observation_gate "$SKILL" "gate_artifacts")
PR_CHECKS=$(get_observation_gate "$SKILL" "pr_checks")
GATE_MECH=$(get_observation_gate "$SKILL" "gate_mechanism")

# Check gate artifacts exist
if [[ -n "$GATE_ARTIFACTS" ]]; then
  for artifact in $GATE_ARTIFACTS; do
    if [[ ! -f "$PROJECT_DIR/.runs/$artifact" ]]; then
      ERRORS+=("$artifact not found — /$SKILL must produce this before PR")
    fi
  done
fi

# Universal: check skill completion for all commit-pr-gate skills
check_skill_completion "$SKILL" "$PROJECT_DIR/.runs/${SKILL}-context.json"

# Fallback for skills without observation config in skill.yaml
if [[ -z "$GATE_MECH" ]]; then
  if [[ ! -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
    ERRORS+=("observe-result.json not found — /$SKILL must complete observation before PR")
  fi
else
  # Dispatch pr_checks from registry
  for check in $PR_CHECKS; do
    case "$check" in
      frontmatter-validation) check_frontmatter ;;
      trace-completeness)     check_trace_completeness ;;
      agent-match)            check_agent_match ;;
      postcondition-rerun)    rerun_postconditions "$SKILL" ;;
      gate-verdicts)          check_gate_verdicts_pr ;;
      acceptance-criteria)    check_acceptance_criteria ;;
      review-metrics)         check_review_metrics ;;
    esac
  done
fi

# Universal: BLOCK verdict check (applies to all skill-driven PRs)
check_block_verdicts

# If any check failed, deny the PR creation
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "PR gate blocked: " "Run /verify to complete verification before creating a PR."
fi

# All checks passed — allow
exit 0
