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

# --- Skill-context guard ---
# Only enforce verification when a skill created a context file for this branch.
# Skills always write *-context.json with a "branch" field in STATE 0.
# Normal conversations never create these files, so their PRs pass through.
SKILL_DRIVEN=false
for ctx in "$PROJECT_DIR"/.runs/*-context.json; do
  [[ -f "$ctx" ]] || continue
  CTX_BRANCH=$(read_json_field "$ctx" "branch")
  if [[ "$CTX_BRANCH" == "$BRANCH" ]]; then
    SKILL_DRIVEN=true
    break
  fi
done

if [[ "$SKILL_DRIVEN" == "false" ]]; then
  exit 0
fi

# Branch-aware checks: skills that don't produce verify-report.md use their own artifacts
if [[ "$BRANCH" =~ ^chore/review- ]]; then
  # /review uses review-complete.json (produced in Step 4)
  if [[ ! -f "$PROJECT_DIR/.runs/review-complete.json" ]]; then
    ERRORS+=("review-complete.json not found — /review must write this after final validation")
  fi
  check_skill_completion "review" "$PROJECT_DIR/.runs/review-context.json"
elif [[ "$BRANCH" =~ ^fix/resolve- ]]; then
  # /resolve uses observe-result.json (produced by skill-epilogue.md)
  if [[ ! -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
    ERRORS+=("observe-result.json not found — /resolve must complete observation before PR")
  fi
  check_skill_completion "resolve" "$PROJECT_DIR/.runs/resolve-context.json"
elif [[ "$BRANCH" =~ ^chore/upgrade-template ]]; then
  # /upgrade uses observe-result.json (Strategy A epilogue) + upgrade-diff-report.json
  if [[ ! -f "$PROJECT_DIR/.runs/upgrade-diff-report.json" ]]; then
    ERRORS+=("upgrade-diff-report.json not found — /upgrade must complete merge validation before PR")
  fi
  if [[ ! -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
    ERRORS+=("observe-result.json not found — /upgrade must complete observation before PR")
  fi
  check_skill_completion "upgrade" "$PROJECT_DIR/.runs/upgrade-context.json"
elif [[ "$BRANCH" =~ ^chore/harden ]]; then
  # /harden runs /verify — require verify-report.md + completed_states
  if [[ ! -f "$REPORT" ]]; then
    ERRORS+=("verify-report.md not found — /harden must run /verify before PR")
  fi
  CTX="$PROJECT_DIR/.runs/harden-context.json"
  if [[ -f "$CTX" ]]; then
    STATES=$(normalize_states "$CTX")
    REQUIRED=$(get_required_states "harden")
    MISSING=$(python3 -c "
cs = set('$STATES'.split())
required = '$REQUIRED'.split()
missing = [s for s in required if s not in cs]
print(','.join(missing) if missing else 'NONE')
" 2>/dev/null || echo "NONE")
    if [[ "$MISSING" != "NONE" ]]; then
      ERRORS+=("harden states [$MISSING] not complete — finish all states before PR")
    fi
  fi
elif [[ "$BRANCH" =~ ^chore/distribute ]]; then
  # /distribute runs /verify — require verify-report.md + completed_states
  if [[ ! -f "$REPORT" ]]; then
    ERRORS+=("verify-report.md not found — /distribute must run /verify before PR")
  fi
  CTX="$PROJECT_DIR/.runs/distribute-context.json"
  if [[ -f "$CTX" ]]; then
    STATES=$(normalize_states "$CTX")
    REQUIRED=$(get_required_states "distribute")
    MISSING=$(python3 -c "
cs = set('$STATES'.split())
required = '$REQUIRED'.split()
missing = [s for s in required if s not in cs]
print(','.join(missing) if missing else 'NONE')
" 2>/dev/null || echo "NONE")
    if [[ "$MISSING" != "NONE" ]]; then
      ERRORS+=("distribute states [$MISSING] not complete — finish all states before PR")
    fi
  fi
elif [[ "$BRANCH" =~ ^chore/upgrade-template ]]; then
  # /upgrade uses its own report artifacts, not verify-report.md
  if [[ ! -f "$PROJECT_DIR/.runs/upgrade-diff-report.json" ]]; then
    ERRORS+=("upgrade-diff-report.json not found — /upgrade must complete merge validation")
  fi
  check_skill_completion "upgrade" "$PROJECT_DIR/.runs/upgrade-context.json"
else
  # Standard path: Checks 1-5 (verify-report.md required)

  # Check 1: verify-report.md exists with YAML frontmatter
  if [[ ! -f "$REPORT" ]]; then
    ERRORS+=("verify-report.md not found — run /verify first")
  elif ! head -1 "$REPORT" | grep -q '^---$'; then
    ERRORS+=("verify-report.md missing YAML frontmatter")
  fi

  if [[ -f "$REPORT" ]]; then
    # Extract frontmatter (between first and second ---)
    FRONTMATTER=$(sed -n '2,/^---$/p' "$REPORT" | sed '$d')

    # Check 2: process_violation is absent or false
    VIOLATION=$(echo "$FRONTMATTER" | grep 'process_violation: *true' || true)
    if [[ -n "$VIOLATION" ]]; then
      ERRORS+=("process_violation is true in verify-report.md — verification agents were skipped")
    fi

    # Check 3: agents_expected matches agents_completed
    EXPECTED=$(echo "$FRONTMATTER" | grep 'agents_expected:' | sed 's/agents_expected: *//' | tr -d '[]' | tr ',' '\n' | sed 's/^ *//;/^$/d' | sort)
    COMPLETED=$(echo "$FRONTMATTER" | grep 'agents_completed:' | sed 's/agents_completed: *//' | tr -d '[]' | tr ',' '\n' | sed 's/^ *//;/^$/d' | sort)
    if [[ "$EXPECTED" != "$COMPLETED" ]]; then
      ERRORS+=("agents_expected does not match agents_completed in verify-report.md")
    fi

    # Check 4: agent-traces directory has matching file count
    if [[ -d "$TRACES_DIR" ]]; then
      TRACE_COUNT=$(find "$TRACES_DIR" -name '*.json' -type f | grep -cEv '(design-critic|ux-journeyer)-[0-9]|/(observer|pattern-classifier|design-consistency-checker)\.json$')
      COMPLETED_COUNT=$(echo "$FRONTMATTER" | grep 'agents_completed:' | sed 's/agents_completed: *//' | tr -d '[]' | tr ',' '\n' | sed '/^$/d' | wc -l | tr -d ' ')
      if [[ "$TRACE_COUNT" -ne "$COMPLETED_COUNT" ]]; then
        ERRORS+=("Agent trace count ($TRACE_COUNT) does not match agents_completed count ($COMPLETED_COUNT)")
      fi
    else
      ERRORS+=("Agent traces directory not found at $TRACES_DIR")
    fi

    # Check 5: hard_gate_failure blocks PR (except standalone mode)
    HARD_GATE=$(echo "$FRONTMATTER" | grep 'hard_gate_failure: *true' || true)
    MODE=$(read_json_field "$PROJECT_DIR/.runs/verify-context.json" "mode")
    if [[ -n "$HARD_GATE" && "$MODE" != "standalone" ]]; then
      ERRORS+=("hard_gate_failure is true — verification hard gate(s) failed; PR blocked in non-standalone mode")
    fi
  fi
fi  # end branch-aware checks

# Check 5.5a: Postcondition re-verification
if [[ "$BRANCH" =~ ^(change|feat|fix)/ ]] && [[ ! "$BRANCH" =~ ^feat/bootstrap ]] && [[ ! "$BRANCH" =~ ^fix/resolve- ]]; then
  rerun_postconditions "change"
elif [[ "$BRANCH" =~ ^chore/harden ]]; then
  rerun_postconditions "harden"
elif [[ "$BRANCH" =~ ^chore/distribute ]]; then
  rerun_postconditions "distribute"
fi

# Check 5.5b: BLOCK verdict check
check_block_verdicts

# Check 6: Gate verdict files (G4, G5, G6) exist with PASS for current branch
# Only required for /change skill branches — other skills use their own verification.
if [[ "$BRANCH" =~ ^(change|feat|fix)/ ]] && [[ ! "$BRANCH" =~ ^feat/bootstrap ]] && [[ ! "$BRANCH" =~ ^fix/resolve- ]]; then
  VERDICTS_DIR="$PROJECT_DIR/.runs/gate-verdicts"
  check_verdict_gates "g4 g5 g6" "$VERDICTS_DIR" "$BRANCH"
fi  # end branch-prefix guard for Check 6

# ─── Check 7: Acceptance Criteria validation ───
# Only for change/feat/fix branches with acceptance_criteria in plan.
# If acceptance_criteria is absent, skip silently (backward compatible).
if [[ "$BRANCH" =~ ^(change|feat|fix)/ ]] && [[ ! "$BRANCH" =~ ^feat/bootstrap ]] && [[ ! "$BRANCH" =~ ^fix/resolve- ]]; then
  PLAN="$PROJECT_DIR/.runs/current-plan.md"
  if [[ -f "$PLAN" ]]; then
    AC_RESULT=$(python3 -c "
import sys, os, json, glob

# Parse YAML frontmatter from plan (manual parse to avoid yaml import dependency)
content = open('$PLAN').read()
if not content.startswith('---'):
    print('SKIP'); sys.exit(0)
parts = content.split('---', 2)
if len(parts) < 3:
    print('SKIP'); sys.exit(0)

# Try yaml first, fall back to manual parse
try:
    import yaml
    fm = yaml.safe_load(parts[1])
except ImportError:
    # Manual parse: look for acceptance_criteria block
    import re
    fm_text = parts[1]
    if 'acceptance_criteria:' not in fm_text:
        print('SKIP'); sys.exit(0)
    # Extract AC entries manually
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

    if [[ "$AC_RESULT" == FAIL:* ]]; then
      ERRORS+=("Acceptance criteria not met: ${AC_RESULT#FAIL:}")
    fi
  fi
fi  # end Check 7

# If any check failed, deny the PR creation
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "PR gate blocked: " "Run /verify to complete verification before creating a PR."
fi

# All checks passed — allow
exit 0
