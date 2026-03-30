#!/usr/bin/env bash
# agent-state-gate.sh — Unified PreToolUse hook for Agent tool.
# Data-driven gating for all skills via state-registry.json agent_gates.
# Replaces phase-transition-gate.sh + bootstrap-agent-gate.sh.

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

SUBAGENT_TYPE=$(read_payload_field "tool_input.subagent_type")

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
TRACES_DIR="$PROJECT_DIR/.claude/agent-traces"
ERRORS=()

# ── Fast-path: no context files → no skill active → allow ──
shopt -s nullglob
CTX_FILES=("$PROJECT_DIR"/.claude/*-context.json)
shopt -u nullglob
if [[ ${#CTX_FILES[@]} -eq 0 ]]; then
  exit 0
fi

# ── Single python3 block: detect active skill + registry checks ──
# Passes payload and agent type via environment variables.
# Returns JSON: {"skill":"...", "errors":[], "warn":""}
# shellcheck disable=SC2153
export _PAYLOAD="$PAYLOAD"
export _AGENT_TYPE="$SUBAGENT_TYPE"
GATE_RESULT=$(python3 << 'PYEOF'
import json, glob, os, sys

project = os.environ.get('CLAUDE_PROJECT_DIR', '.')
agent_type = os.environ.get('_AGENT_TYPE', '')
payload_str = os.environ.get('_PAYLOAD', '{}')

try:
    payload = json.loads(payload_str)
except:
    payload = {}

isolation = payload.get('tool_input', {}).get('isolation', '')

# 1. Detect active skill — scan *-context.json, pick most recent timestamp
ctx_files = glob.glob(os.path.join(project, '.claude', '*-context.json'))
# Filter out epilogue-context.json for active skill detection
ctx_files = [f for f in ctx_files if 'epilogue-context' not in f]

best_skill = ''
best_ts = ''
for cf in ctx_files:
    try:
        d = json.load(open(cf))
        ts = d.get('timestamp', '')
        if ts > best_ts:
            best_ts = ts
            best_skill = d.get('skill', os.path.basename(cf).replace('-context.json', ''))
    except:
        pass

if not best_skill:
    print(json.dumps({'skill': '', 'errors': [], 'warn': ''}))
    sys.exit(0)

# 2. Load registry
reg_path = os.path.join(project, '.claude', 'patterns', 'state-registry.json')
if not os.path.isfile(reg_path):
    print(json.dumps({'skill': best_skill, 'errors': [], 'warn': 'registry missing'}))
    sys.exit(0)

reg = json.load(open(reg_path))
agent_gates = reg.get('agent_gates', {})
skill_gates = agent_gates.get(best_skill, {})

# 3. Resolve gate config for this agent type
gate = skill_gates.get(agent_type, skill_gates.get('_default', None))

errors = []
warn = ''

if gate is None:
    if skill_gates:
        warn = f'unrecognized agent {agent_type} for skill {best_skill}'
    # else: skill has no gates at all — silent allow
elif gate.get('allow_unconditional'):
    pass  # always allow
else:
    # Check deny_isolation
    for denied in gate.get('deny_isolation', []):
        if isolation == denied:
            errors.append(f'{agent_type} cannot use isolation={denied} — agents for {best_skill} must share the main filesystem')

    # Check deny_background
    run_in_bg = payload.get('tool_input', {}).get('run_in_background', False)
    deny_bg = gate.get('deny_background', False)
    if deny_bg and run_in_bg:
        errors.append(f"Agent type '{agent_type}' requires foreground execution (deny_background=true) but run_in_background=true")

    # Check required_states (using registry key order for proper ordering)
    required = gate.get('required_states', [])
    if required:
        ctx_file = os.path.join(project, '.claude',
            'verify-context.json' if best_skill == 'verify'
            else f'{best_skill}-context.json')
        if os.path.isfile(ctx_file):
            ctx = json.load(open(ctx_file))
            cs = [str(s) for s in ctx.get('completed_states', [])]
            if not cs:
                pass  # Fail-open if field absent (backward compat)
            else:
                missing = [str(r) for r in required if str(r) not in cs]
                if missing:
                    errors.append(f"States [{','.join(missing)}] not in completed_states — prerequisite states were skipped")

    # Check artifacts
    for art in gate.get('artifacts', []):
        art_path = os.path.join(project, art)
        if not os.path.isfile(art_path):
            errors.append(f'{os.path.basename(art)} missing — required artifact for {agent_type}')

print(json.dumps({'skill': best_skill, 'errors': errors, 'warn': warn}))
PYEOF
)
unset _PAYLOAD _AGENT_TYPE

# Parse python3 output
ACTIVE_SKILL=$(echo "$GATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('skill',''))" 2>/dev/null || echo "")
GATE_WARN=$(echo "$GATE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('warn',''))" 2>/dev/null || echo "")

# Accumulate registry errors
while IFS= read -r line; do
  [[ -n "$line" ]] && ERRORS+=("$line")
done < <(echo "$GATE_RESULT" | python3 -c "import json,sys; [print(x) for x in json.load(sys.stdin).get('errors',[])]" 2>/dev/null || true)

# Log warnings
if [[ -n "$GATE_WARN" ]]; then
  echo "WARN: agent-state-gate: $GATE_WARN" >&2
fi

# ══════════════════════════════════════════════════════════════════════
# Extended checks: verify
# Helper functions (check_trace_run_id, check_postcondition_artifacts,
# check_tier1_retry_complete, check_efficiency_directives,
# check_build_result, check_file_boundary, require_trace_verdict)
# are in lib.sh.
# ══════════════════════════════════════════════════════════════════════

verify_extended_checks() {
  case "$SUBAGENT_TYPE" in
    design-critic|ux-journeyer)
      # Archetype guard: these agents are web-app only
      local DC_ARCH
      DC_ARCH=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "archetype")
      if [[ "$DC_ARCH" != "web-app" ]]; then
        ERRORS+=("$SUBAGENT_TYPE requires archetype=web-app but got archetype=$DC_ARCH — design agents are not valid for service or cli archetypes")
      fi
      check_postcondition_artifacts 0
      check_build_result
      # Phase 1 traces must exist
      if [[ ! -f "$TRACES_DIR/build-info-collector.json" ]]; then
        ERRORS+=("build-info-collector.json trace missing — Phase 1 has not completed")
      fi
      require_trace_verdict "$TRACES_DIR/build-info-collector.json" "agent may still be running or exhausted turns"
      check_trace_run_id "$TRACES_DIR/build-info-collector.json"

      local SCOPE
      SCOPE=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "scope")
      if [[ "$SCOPE" == "full" || "$SCOPE" == "security" ]]; then
        for AGENT in security-defender security-attacker behavior-verifier; do
          if [[ ! -f "$TRACES_DIR/$AGENT.json" ]]; then
            ERRORS+=("$AGENT.json trace missing — Phase 1 agent incomplete (scope=$SCOPE)")
          else
            require_trace_verdict "$TRACES_DIR/$AGENT.json" "agent may still be running or exhausted turns"
            check_trace_run_id "$TRACES_DIR/$AGENT.json"
          fi
        done
      fi
      # Per-page design-critic file boundary enforcement
      if [[ "$SUBAGENT_TYPE" == "design-critic" ]]; then
        local IS_PER_PAGE
        IS_PER_PAGE=$(python3 -c "
import json, sys, re
d = json.loads(sys.stdin.read())
prompt = d.get('tool_input',{}).get('prompt','')
if re.search(r'design-critic-\w+\.json', prompt):
    print('yes')
else:
    print('no')
" <<< "$PAYLOAD" 2>/dev/null || echo "no")
        if [[ "$IS_PER_PAGE" == "yes" ]]; then
          check_file_boundary "design-critic (per-page)"
        fi
      fi
      # ux-journeyer: check design-critic retry + consistency checker
      if [[ "$SUBAGENT_TYPE" == "ux-journeyer" ]]; then
        check_tier1_retry_complete "design-critic-*" "$TRACES_DIR"
        check_tier1_retry_complete "design-critic" "$TRACES_DIR"
        local SCOPE_V1 ARCH_V1
        SCOPE_V1=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "scope")
        ARCH_V1=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "archetype")
        if [[ "$SCOPE_V1" =~ ^(full|visual)$ ]] && [[ "$ARCH_V1" == "web-app" ]]; then
          if [ ! -f "$TRACES_DIR/design-consistency-checker.json" ]; then
            ERRORS+=("design-consistency-checker.json trace missing — spawn consistency checker before ux-journeyer")
          else
            require_trace_verdict "$TRACES_DIR/design-consistency-checker.json" "consistency checker may still be running or exhausted turns"
          fi
        fi
      fi
      check_efficiency_directives
      ;;

    security-fixer)
      check_postcondition_artifacts 3
      if [[ ! -f "$TRACES_DIR/build-info-collector.json" ]]; then
        ERRORS+=("build-info-collector.json trace missing — Phase 1 has not completed")
      fi
      require_trace_verdict "$TRACES_DIR/build-info-collector.json" "agent may still be running or exhausted turns"
      check_trace_run_id "$TRACES_DIR/build-info-collector.json"

      local SF_SCOPE SF_ARCH
      SF_SCOPE=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "scope")
      SF_ARCH=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "archetype")
      if [[ "$SF_ARCH" == "web-app" && ( "$SF_SCOPE" == "full" || "$SF_SCOPE" == "visual" ) ]]; then
        for AGENT in design-critic ux-journeyer; do
          if [[ ! -f "$TRACES_DIR/$AGENT.json" ]]; then
            ERRORS+=("$AGENT.json trace missing — Phase 2 agent incomplete (scope=$SF_SCOPE, archetype=$SF_ARCH)")
          else
            require_trace_verdict "$TRACES_DIR/$AGENT.json" "agent may still be running or exhausted turns"
            check_trace_run_id "$TRACES_DIR/$AGENT.json"
          fi
        done
      fi
      check_tier1_retry_complete "ux-journeyer" "$TRACES_DIR"
      # Hard gate: design-ux-merge.json verdict must not be "fail"
      if [[ "$SF_ARCH" == "web-app" && ( "$SF_SCOPE" == "full" || "$SF_SCOPE" == "visual" ) ]]; then
        if [[ -f "$PROJECT_DIR/.claude/design-ux-merge.json" ]]; then
          local MERGE_VERDICT
          MERGE_VERDICT=$(read_json_field "$PROJECT_DIR/.claude/design-ux-merge.json" "verdict")
          if [[ "$MERGE_VERDICT" == "fail" ]]; then
            ERRORS+=("design-ux-merge.json verdict=fail — hard gate failure, skip to STATE 7")
          fi
        fi
      fi
      if [[ "$SF_SCOPE" == "security" ]]; then
        if [[ ! -f "$TRACES_DIR/behavior-verifier.json" ]]; then
          ERRORS+=("behavior-verifier.json trace missing — Phase 1 agent incomplete (scope=$SF_SCOPE)")
        fi
        require_trace_verdict "$TRACES_DIR/behavior-verifier.json" "agent may still be running or exhausted turns"
        check_trace_run_id "$TRACES_DIR/behavior-verifier.json"
      fi
      check_efficiency_directives
      ;;

    observer)
      # Epilogue path: relaxed requirements for skill-epilogue.md observers
      if [[ -f "$PROJECT_DIR/.claude/epilogue-context.json" ]] && \
         [[ ! -f "$PROJECT_DIR/.claude/verify-context.json" ]]; then
        local FIX_COUNT
        FIX_COUNT=$(grep -cE '^\*\*Fix|^Fix \(' "$PROJECT_DIR/.claude/fix-log.md" 2>/dev/null || echo "0")
        if [ "$FIX_COUNT" -gt 0 ] && [ ! -s "$PROJECT_DIR/.claude/observer-diffs.txt" ]; then
          ERRORS+=("observer-diffs.txt missing or empty — collect diffs before spawning observer (epilogue path)")
        fi
      else
        # Verify path: full prerequisites
        check_postcondition_artifacts 4
        if [[ ! -f "$PROJECT_DIR/.claude/e2e-result.json" ]]; then
          ERRORS+=("e2e-result.json not found — E2E tests (STATE 5) must complete before observer")
        fi
        if [[ -f "$PROJECT_DIR/.claude/e2e-result.json" ]]; then
          local HAS_TESTING
          HAS_TESTING=$(grep -c "testing:" "$PROJECT_DIR/experiment/experiment.yaml" 2>/dev/null || echo "0")
          if [[ "$HAS_TESTING" -gt 0 ]]; then
            local E2E_REASON
            E2E_REASON=$(read_json_field "$PROJECT_DIR/.claude/e2e-result.json" "reason")
            if [[ "$E2E_REASON" == "no testing stack" ]]; then
              ERRORS+=("e2e-result.json says 'no testing stack' but experiment.yaml has stack.testing — STATE 5 was not executed correctly")
            fi
          fi
        fi
        local FIX_COUNT
        FIX_COUNT=$(grep -cE '^\*\*Fix|^Fix \(' "$PROJECT_DIR/.claude/fix-log.md" 2>/dev/null || echo "0")
        if [ "$FIX_COUNT" -gt 0 ] && [ ! -s "$PROJECT_DIR/.claude/observer-diffs.txt" ]; then
          ERRORS+=("observer-diffs.txt missing or empty — run diff collection script before spawning observer")
        fi
        check_efficiency_directives
      fi
      ;;

    build-info-collector|security-defender|security-attacker|behavior-verifier|performance-reporter|accessibility-scanner|spec-reviewer)
      check_postcondition_artifacts 0
      check_build_result
      check_efficiency_directives
      ;;

    design-consistency-checker)
      check_postcondition_artifacts 0
      check_build_result
      local HAS_SHARED
      HAS_SHARED=$(python3 -c "
import json, glob
for f in glob.glob('$TRACES_DIR/design-critic-*.json'):
    if 'design-critic-shared' in f: continue
    try:
        d = json.load(open(f))
        if d.get('unresolved_shared', 0) > 0:
            print('yes'); break
    except: pass
else: print('no')
" 2>/dev/null || echo "no")
      if [[ "$HAS_SHARED" == "yes" ]]; then
        if [[ ! -f "$TRACES_DIR/design-critic-shared.json" ]]; then
          ERRORS+=("design-critic-shared.json missing — per-page agents reported shared-component issues")
        else
          require_trace_verdict "$TRACES_DIR/design-critic-shared.json" "shared-component agent may still be running"
        fi
      fi
      check_efficiency_directives
      ;;

    pattern-classifier)
      if [[ -f "$PROJECT_DIR/.claude/verify-context.json" ]]; then
        if [[ ! -f "$PROJECT_DIR/.claude/fix-log.md" ]]; then
          ERRORS+=("fix-log.md missing — cannot run pattern-classifier outside verify context")
        fi
      fi
      ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════
# Extended checks: bootstrap
# Ports all bootstrap-specific logic from bootstrap-agent-gate.sh
# ══════════════════════════════════════════════════════════════════════

bootstrap_extended_checks() {
  case "$SUBAGENT_TYPE" in
    scaffold-*)
      local VERDICTS_DIR="$PROJECT_DIR/.claude/gate-verdicts"
      local BRANCH
      BRANCH=$(get_branch)

      # BG1 verdict PASS + branch match
      check_verdict_gates "bg1" "$VERDICTS_DIR" "$BRANCH"

      # scaffold-pages/landing: root files + scaffold-libs completion
      if [[ "$SUBAGENT_TYPE" == "scaffold-pages" ]] || [[ "$SUBAGENT_TYPE" == "scaffold-landing" ]]; then
        for REQUIRED_FILE in "src/app/layout.tsx" "src/app/not-found.tsx" "src/app/error.tsx"; do
          if [[ ! -f "$PROJECT_DIR/$REQUIRED_FILE" ]]; then
            ERRORS+=("Phase A file '$REQUIRED_FILE' missing — lead must create root files before spawning page/landing agents")
          fi
        done

        local LIBS_MANIFEST="$PROJECT_DIR/.claude/agent-traces/scaffold-libs.json"
        if [[ ! -f "$LIBS_MANIFEST" ]]; then
          ERRORS+=("scaffold-libs manifest missing — scaffold-libs must complete before page/landing agents")
        else
          local LIBS_STATUS
          LIBS_STATUS=$(read_json_field "$LIBS_MANIFEST" "status")
          if [[ "$LIBS_STATUS" != "complete" ]]; then
            ERRORS+=("scaffold-libs status is '$LIBS_STATUS', not 'complete' — wait for scaffold-libs to finish")
          fi
        fi
      fi

      # scaffold-wire: BG2 verdict PASS
      if [[ "$SUBAGENT_TYPE" == "scaffold-wire" ]]; then
        check_verdict_gates "bg2" "$VERDICTS_DIR"
      fi
      ;;
  esac
}

# ══════════════════════════════════════════════════════════════════════
# Extended checks: change (G3 verdict PASS + branch match)
# ══════════════════════════════════════════════════════════════════════

change_extended_checks() {
  if [[ "$SUBAGENT_TYPE" == "implementer" || "$SUBAGENT_TYPE" == "visual-implementer" ]]; then
    local VERDICTS_DIR="$PROJECT_DIR/.claude/gate-verdicts"
    check_verdict_gates "g3" "$VERDICTS_DIR" "$(get_branch)"
  fi
}

# ── Run extended checks based on active skill ──
if [[ "$ACTIVE_SKILL" == "verify" ]]; then
  verify_extended_checks
elif [[ "$ACTIVE_SKILL" == "bootstrap" ]]; then
  bootstrap_extended_checks
elif [[ "$ACTIVE_SKILL" == "change" ]]; then
  change_extended_checks
fi

# ── Deny or allow ──
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "State gate blocked: " "Complete prerequisite states before spawning $SUBAGENT_TYPE."
fi

# All checks passed — allow
exit 0
