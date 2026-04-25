#!/usr/bin/env bash
# lib-verdict.sh — Verdict checking and gate validation functions.
# Sourced via lib.sh facade. Do NOT source directly.
# Requires: ERRORS array (from caller). Cross-module: read_json_field, get_branch (lib-core.sh).

# --- check_verdict_error ---
# Unconditionally rejects verdict "error" in observe-result.json.
# Placed BEFORE check_verdict_consistency because that function has early-return
# guards on diffs existence — process-scope skills (e.g., /solve) with no diffs
# would bypass it. This function has NO early-return guards.
# Appends to global ERRORS array. Does not exit — caller decides.
# Usage: check_verdict_error
check_verdict_error() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local obs_file="$project_dir/.runs/observe-result.json"

  [[ ! -f "$obs_file" ]] && return 0

  local verdict
  verdict=$(read_json_field "$obs_file" "verdict")

  if [[ "$verdict" == "error" ]]; then
    local reason
    reason=$(read_json_field "$obs_file" "error_reason")
    ERRORS+=("Observation failed with verdict 'error': ${reason:-unknown reason}. Re-run the skill to retry observation.")
  fi
}

# --- check_fixlog_verdict_consistency (AOC v1 FLS v1 canonical) ---
# Blocks if: fix-ledger.jsonl has entries (or, transitional fallback,
# fix-log.md has entries) but verdict is "clean" (not execution-audit).
# Catches the case where observation-phase.md was skipped but agents
# produced fixes that went unobserved.
# Appends to global ERRORS array. Does not exit — caller decides.
# Usage: check_fixlog_verdict_consistency
check_fixlog_verdict_consistency() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local obs_file="$project_dir/.runs/observe-result.json"
  local ledger="$project_dir/.runs/fix-ledger.jsonl"
  local fixlog="$project_dir/.runs/fix-log.md"

  [[ ! -f "$obs_file" ]] && return 0

  # Authoritative count: ledger row count (one JSON per line).
  # Transitional fallback: prose fix-log non-empty non-header lines.
  local entry_count=0
  if [[ -f "$ledger" ]]; then
    entry_count=$(grep -c -v '^\s*$' "$ledger" 2>/dev/null || echo "0")
  elif [[ -f "$fixlog" ]]; then
    entry_count=$(grep -c -v '^\s*$\|^#' "$fixlog" 2>/dev/null || echo "0")
  fi
  [[ "$entry_count" -eq 0 ]] && return 0

  local verdict strategy
  verdict=$(read_json_field "$obs_file" "verdict")
  strategy=$(read_json_field "$obs_file" "strategy")

  if [[ "$verdict" == "clean" ]] && [[ "$strategy" != "execution-audit" ]]; then
    ERRORS+=("Verdict inconsistency: fix ledger/log has $entry_count entries but verdict is 'clean'. Observation was skipped or incomplete.")
  fi
}

# --- check_verdict_consistency ---
# Checks that observe-result.json verdict is consistent with observer-diffs.txt content.
# Blocks if: non-empty diffs + verdict "clean" + not execution-audit + not dry-run.
# Appends to global ERRORS array. Does not exit — caller decides.
# Usage: check_verdict_consistency "$SKILL"
check_verdict_consistency() {
  local skill="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local diffs_file="$project_dir/.runs/observer-diffs.txt"
  local obs_file="$project_dir/.runs/observe-result.json"
  local ctx_file="$project_dir/.runs/${skill}-context.json"

  # Only check if both files exist and diffs is non-empty
  [[ ! -f "$diffs_file" ]] && return 0
  [[ ! -s "$diffs_file" ]] && return 0
  [[ ! -f "$obs_file" ]] && return 0

  local verdict strategy dry_run
  verdict=$(read_json_field "$obs_file" "verdict")
  strategy=$(read_json_field "$obs_file" "strategy")
  dry_run=$(read_json_field "$ctx_file" "dry_run")

  # Invariant: non-empty diffs + "clean" verdict + Strategy A = violation
  if [[ "$verdict" == "clean" ]] && [[ "$strategy" != "execution-audit" ]] && [[ "$dry_run" != "True" ]]; then
    ERRORS+=("Verdict inconsistency: observer-diffs.txt has content but observe-result.json verdict is 'clean' — the observer was not spawned. Re-run the skill epilogue.")
  fi
}

# --- check_verdict_gates ---
# Loops over gate verdict files, checks existence + PASS verdict + optional branch match.
# Appends errors to the global ERRORS array. Does not exit — caller decides.
# $1: space-separated list of gate names (e.g., "bg1 bg2 bg2.5 bg4")
# $2: verdicts directory path
# $3: (optional) branch name — when set, also validates verdict.branch matches
# Usage: check_verdict_gates "bg1 bg2 bg2.5 bg4" "$VERDICTS_DIR"
#        check_verdict_gates "g4 g5 g6" "$VERDICTS_DIR" "$BRANCH"
check_verdict_gates() {
  local gates_list="$1" verdicts_dir="$2" branch="${3:-}"
  for gate in $gates_list; do
    local gf="$verdicts_dir/$gate.json"
    if [[ ! -f "$gf" ]]; then
      ERRORS+=("${gate^^} verdict missing")
      continue
    fi
    local v; v=$(read_json_field "$gf" "verdict")
    [[ "$v" != "PASS" ]] && ERRORS+=("${gate^^} verdict is ${v:-?}, not PASS")
    if [[ -n "$branch" ]]; then
      local vb; vb=$(read_json_field "$gf" "branch")
      [[ -n "$vb" && "$vb" != "$branch" ]] && ERRORS+=("${gate^^} verdict is for branch $vb, not $branch")
    fi
  done
}

# --- check_trace_verdict ---
# Checks a single field in a trace JSON file against an expected value.
# Returns "yes" (match), "no" (mismatch), or "missing" (file/field absent).
# Usage: RESULT=$(check_trace_verdict "/path/to/trace.json" "verdict" "PASS")
check_trace_verdict() {
  local trace_file="$1" field="$2" expected="$3"
  [[ ! -f "$trace_file" ]] && { echo "missing"; return; }
  python3 -c "
import json
try:
    d = json.load(open('$trace_file'))
    val = d.get('$field')
    if val is None: print('missing')
    elif str(val) == '$expected': print('yes')
    else: print('no')
except: print('missing')
" 2>/dev/null || echo "missing"
}

# --- require_trace_verdict ---
# Checks that a trace file has a verdict field (any value).
# Appends to global ERRORS if file exists but verdict is absent.
# No-op if trace file doesn't exist (caller checks existence separately).
# Usage: require_trace_verdict "$TRACES_DIR/agent.json" "context message"
require_trace_verdict() {
  local trace_file="$1" context="$2"
  if [[ -f "$trace_file" ]]; then
    local result
    result=$(check_trace_verdict "$trace_file" "verdict" "__ANY__")
    if [[ "$result" == "missing" ]]; then
      ERRORS+=("$(basename "$trace_file") trace incomplete (no verdict) — $context")
    fi
  fi
}

# --- check_trace_run_id ---
# Validates that a trace file's run_id matches the verify-context.json run_id.
# Appends to global ERRORS if run_id is stale (from a prior /verify run).
# No-op if trace or context file is missing.
# Usage: check_trace_run_id "$TRACES_DIR/agent.json"
check_trace_run_id() {
  local TRACE_FILE="$1"
  # shellcheck disable=SC2153
  if [[ ! -f "$TRACE_FILE" ]] || [[ ! -f "$PROJECT_DIR/.runs/verify-context.json" ]]; then
    return 0
  fi
  local RESULT
  RESULT=$(python3 -c "
import json
ctx = json.load(open('$PROJECT_DIR/.runs/verify-context.json'))
trace = json.load(open('$TRACE_FILE'))
ctx_run_id = ctx.get('run_id', '')
trace_run_id = trace.get('run_id', '')
if not trace_run_id:
    print('WARN')
elif not ctx_run_id:
    print('OK')
elif trace_run_id != ctx_run_id:
    print('STALE')
else:
    print('OK')
" 2>/dev/null || echo "OK")
  if [[ "$RESULT" == "STALE" ]]; then
    local BASENAME
    BASENAME=$(basename "$TRACE_FILE")
    ERRORS+=("$BASENAME has stale run_id — trace is from a prior /verify run, not the current one")
  fi
}

# --- check_block_verdicts ---
# Checks gate-verdicts/ for any BLOCK verdicts on the current branch.
# Appends blocking gate IDs to global ERRORS array. Does not exit — caller decides.
# Usage: check_block_verdicts
check_block_verdicts() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local verdicts_dir="$project_dir/.runs/gate-verdicts"
  [[ ! -d "$verdicts_dir" ]] && return 0

  local branch
  branch=$(get_branch)

  for gf in "$verdicts_dir"/*.json; do
    [[ -f "$gf" ]] || continue
    local v; v=$(read_json_field "$gf" "verdict")
    [[ "$v" != "BLOCK" ]] && continue
    local vb; vb=$(read_json_field "$gf" "branch")
    if [[ "$vb" == "$branch" ]]; then
      local gate_id
      gate_id=$(basename "$gf" .json)
      ERRORS+=("Gate ${gate_id^^} has BLOCK verdict on branch $branch")
    fi
  done
}

# --- check_hard_gate_trace ---
# Checks a single agent's hard gate trace file.
# Reads specified fields, evaluates an agent-specific condition, and appends
# to global ERRORS if the condition fires but hard_gate_failure is not set.
# Uses caller's $CONTENT and $ERRORS (global).
# $1: agent name (e.g., "design-critic")
# $2: trace directory path
# $3: condition expression (bash [[ ]] body, referencing field values as $F_<fieldname>)
# $4+: field names to read from trace JSON
# Usage: check_hard_gate_trace "design-critic" "$TRACE_DIR" \
#          '"$F_verdict" == "unresolved" || "$F_recovery" == "True"' \
#          verdict recovery
check_hard_gate_trace() {
  local agent="$1" trace_dir="$2" condition="$3"
  shift 3
  local field_names=("$@")

  local trace_file="$trace_dir/${agent}.json"
  [[ ! -f "$trace_file" ]] && return 0

  # Read fields and build error detail string
  local msg_parts=""
  for fname in "${field_names[@]}"; do
    local val
    val=$(read_json_field "$trace_file" "$fname")
    # shellcheck disable=SC2086
    declare "F_${fname}=${val}"
    msg_parts+=" ${fname}=${val}"
  done

  # Evaluate agent-specific condition (args are hardcoded by callers, not user input)
  # shellcheck disable=SC2294
  if eval "[[ $condition ]]"; then
    if ! echo "$CONTENT" | grep -q 'hard_gate_failure: *true'; then
      ERRORS+=("${agent}${msg_parts} requires hard_gate_failure: true in report frontmatter")
    fi
  fi
}

# --- check_hard_gate_predicates ---
# v2 (agent-trace lifecycle contract): predicate-based hard gate evaluation.
# Reads agent-registry.json's hard_gates[].allow_predicates and
# additional_block_conditions for a single agent; blocks the report when no
# allow_predicate passes OR when any additional_block_condition fires.
# Unlike check_hard_gate_trace (v1), this function understands the four
# provenance values and the recovery_validated field introduced for issues
# #958 / #960 / #963 — recovery:true is NO LONGER a blanket block trigger.
#
# Uses caller's $CONTENT, $ERRORS (global), $PROJECT_DIR.
# $1: agent name (e.g., "design-critic")
# $2: trace directory path
# Usage: check_hard_gate_predicates "design-critic" "$TRACE_DIR"
check_hard_gate_predicates() {
  local agent="$1" trace_dir="$2"
  local trace_file="$trace_dir/${agent}.json"
  [[ ! -f "$trace_file" ]] && return 0

  local reg="${CLAUDE_PROJECT_DIR:-.}/.claude/patterns/agent-registry.json"
  [[ ! -f "$reg" ]] && return 0

  # Shell out to Python for predicate evaluation — keeps the logic readable
  # and shared with tests.
  local eval_result
  eval_result=$(AGENT_ENV="$agent" TRACE_ENV="$trace_file" TRACES_DIR_ENV="$trace_dir" REG_ENV="$reg" python3 - << 'PYEOF'
import json, os, sys

agent = os.environ['AGENT_ENV']
trace_file = os.environ['TRACE_ENV']
traces_dir = os.environ['TRACES_DIR_ENV']
reg = json.load(open(os.environ['REG_ENV']))

# Find hard gate entry
gate = next((g for g in reg.get('hard_gates', []) if g.get('agent') == agent), None)
if gate is None:
    sys.exit(0)

try:
    trace = json.load(open(trace_file))
except Exception as exc:
    print('READ_ERROR:' + str(exc))
    sys.exit(0)

# --- Predicate definitions (must match agent-registry._hard_gates_predicate_docs) ---

def pass_clean(t):
    # AOC v1: agent found nothing to do. No work performed.
    return (t.get('verdict') == 'pass'
            and t.get('result') == 'clean'
            and t.get('provenance') == 'self')

def pass_after_fixes(t):
    # AOC v1: agent found issues and resolved them; no unresolved criticals.
    try:
        unresolved_critical = int(t.get('unresolved_critical', 0))
    except (TypeError, ValueError):
        unresolved_critical = 0
    return (t.get('verdict') == 'pass'
            and t.get('result') in ('fixed', 'partial')
            and t.get('provenance') == 'self'
            and unresolved_critical == 0)

def pass_self_pass_or_fail(t):
    return t.get('verdict') in ('pass', 'fail') and t.get('provenance') == 'self'

def pass_self_strict(t):
    return t.get('verdict') == 'pass' and t.get('provenance') == 'self'

def validated_fallback(t):
    # AOC v1.1: lead-on-behalf added — agent succeeded but write was blocked,
    # lead transcribed the agent's reported result. Subject to the same
    # recovery_validated discipline as recovery / self-degraded so downstream
    # gates require independent evidence (build + e2e + diff-fix correlation).
    return (t.get('provenance') in ('recovery', 'self-degraded', 'lead-on-behalf')
            and t.get('recovery_validated') is True)

def legacy_pass_no_recovery(t):
    # Pre-migration traces lack provenance; accept verdict==pass without recovery
    if t.get('provenance') is not None:
        return False
    return t.get('verdict') == 'pass' and not t.get('recovery')

# --- AOC v1.1 lead-* predicates ---

def pass_lead_on_behalf(t):
    # Agent succeeded; lead transcribed because the agent's own trace write
    # was blocked or it ran out of tool budget. Spawn-log entry must exist
    # (enforced by state-completion-gate's universal provenance check) — that
    # check is upstream of these predicates, so we trust spawn-log presence
    # here. Source attestation already enforced by artifact-integrity-gate.
    # recovery_validated is required for downstream confidence (the gate
    # operator earns the "agent succeeded" trust by independent evidence).
    return (t.get('verdict') == 'pass'
            and t.get('provenance') == 'lead-on-behalf'
            and t.get('recovery_validated') is True)

def pass_lead_fix(t):
    # Lead applied an in-flight fix during a verify stage. lead_attestation:true
    # is the marker (enforced by artifact-integrity-gate). Lead has direct
    # knowledge — confidence ~1.0, no recovery_validated required.
    return (t.get('verdict') == 'pass'
            and t.get('provenance') == 'lead-fix'
            and t.get('lead_attestation') is True)

def pass_lead_synthesized(t):
    # Agent was never spawned (covered by another mechanism). Lead writes a
    # consistency marker. coverage_provider must name the artifact (enforced
    # by artifact-integrity-gate). no_fixes_claimed:true is the typical case.
    return (t.get('verdict') == 'pass'
            and t.get('provenance') == 'lead-synthesized'
            and bool(t.get('coverage_provider')))

def aggregate_ok(t, agent):
    if t.get('provenance') != 'lead-merge':
        return False
    csi = t.get('contributing_spawn_indexes')
    if not isinstance(csi, list) or len(csi) == 0:
        return False
    # Each contributing sibling trace must satisfy a pass-class predicate.
    # AOC v1.1: lead-* predicates are accepted as siblings (e.g., one
    # design-critic page completed normally, another was lead-on-behalf
    # transcribed because the agent's write was blocked).
    import glob
    sibs = glob.glob(os.path.join(traces_dir, agent + '-*.json'))
    if not sibs:
        return False
    ok = True
    for sf in sibs:
        try:
            sib = json.load(open(sf))
        except Exception:
            ok = False
            break
        if not (
            pass_clean(sib)
            or pass_after_fixes(sib)
            or pass_self_pass_or_fail(sib)
            or validated_fallback(sib)
            or legacy_pass_no_recovery(sib)
            or pass_lead_on_behalf(sib)
            or pass_lead_fix(sib)
            or pass_lead_synthesized(sib)
        ):
            ok = False
            break
    return ok

predicate_fns = {
    'pass_clean': lambda t: pass_clean(t),
    'pass_after_fixes': lambda t: pass_after_fixes(t),
    'pass_self_pass_or_fail': lambda t: pass_self_pass_or_fail(t),
    'pass_self_strict': lambda t: pass_self_strict(t),
    'validated_fallback': lambda t: validated_fallback(t),
    'legacy_pass_no_recovery': lambda t: legacy_pass_no_recovery(t),
    'aggregate_ok': lambda t: aggregate_ok(t, agent),
    'pass_lead_on_behalf': lambda t: pass_lead_on_behalf(t),
    'pass_lead_fix': lambda t: pass_lead_fix(t),
    'pass_lead_synthesized': lambda t: pass_lead_synthesized(t),
}

allow_predicates = gate.get('allow_predicates', [])
any_allowed = False
for p in allow_predicates:
    fn = predicate_fns.get(p)
    if fn is None:
        print(f'UNKNOWN_PREDICATE:{p}')
        sys.exit(0)
    if fn(trace):
        any_allowed = True
        break

# Additional block conditions (agent-specific field thresholds)
blocks = []
for cond in gate.get('additional_block_conditions', []) or []:
    if 'all' in cond:
        sub_all_hit = True
        detail = []
        for sub in cond['all']:
            fld = sub.get('field')
            val = trace.get(fld)
            if 'eq' in sub:
                hit = str(val) == str(sub['eq'])
            elif 'gt' in sub:
                try:
                    hit = int(val) > int(sub['gt'])
                except (TypeError, ValueError):
                    hit = False
            else:
                hit = False
            if not hit:
                sub_all_hit = False
                break
            detail.append(f'{fld}={val}')
        if sub_all_hit:
            blocks.append(' AND '.join(detail))
    else:
        fld = cond.get('field')
        val = trace.get(fld)
        if 'eq' in cond:
            hit = str(val) == str(cond['eq'])
        elif 'gt' in cond:
            try:
                hit = int(val) > int(cond['gt'])
            except (TypeError, ValueError):
                hit = False
        else:
            hit = False
        if hit:
            blocks.append(f'{fld}={val}')

# Output result: OK | BLOCK:<reason>
if not any_allowed and blocks:
    print('BLOCK:no allow_predicate satisfied AND additional block triggered (' + '; '.join(blocks) + ')')
elif not any_allowed:
    reasons = [f'{k}={trace.get(k)}' for k in ('verdict', 'provenance', 'recovery_validated', 'recovery')]
    print('BLOCK:no allow_predicate satisfied (' + ', '.join(reasons) + ')')
elif blocks:
    print('BLOCK:additional block triggered (' + '; '.join(blocks) + ')')
else:
    print('OK')
PYEOF
)

  case "$eval_result" in
    OK|"")
      return 0
      ;;
    BLOCK:*)
      if ! echo "$CONTENT" | grep -q 'hard_gate_failure: *true'; then
        ERRORS+=("${agent} hard gate: ${eval_result#BLOCK:}")
      fi
      ;;
    READ_ERROR:*|UNKNOWN_PREDICATE:*)
      ERRORS+=("${agent} hard gate evaluation error: ${eval_result}")
      ;;
  esac
}
