#!/usr/bin/env bash
# lib.sh — shared functions for Claude Code hooks.
# Source from hooks: source "$(dirname "$0")/lib.sh"
# Call parse_payload first — it reads stdin into PAYLOAD.
# Do NOT register this file in settings.json — it is sourced, not invoked.

# --- parse_payload ---
# Reads stdin into global PAYLOAD. Must be called before any read_payload_field.
parse_payload() {
  PAYLOAD=$(cat)
}

# --- get_branch ---
# Returns current git branch. Caches in CURRENT_BRANCH on first call.
get_branch() {
  if [[ -z "${CURRENT_BRANCH+x}" ]]; then
    CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")
  fi
  echo "$CURRENT_BRANCH"
}

# --- deny ---
# Outputs deny JSON and exits 0. Used for single-message denials.
# IMPORTANT: This calls exit 0 — it terminates the hook process.
# Never call deny() inside a subshell like $(deny "msg").
# Usage: deny "Your message here"
deny() {
  local msg="$1"
  printf '{"permissionDecision": "deny", "message": "%s"}\n' "$msg"
  exit 0
}

# --- deny_errors ---
# Joins global ERRORS array with "; ", outputs deny JSON, exits 0.
# Usage: deny_errors "Prefix: " "Suffix."
deny_errors() {
  local prefix="$1"
  local suffix="$2"
  local joined
  joined=$(printf '%s; ' "${ERRORS[@]}")
  printf '{"permissionDecision": "deny", "message": "%s%s%s"}\n' "$prefix" "$joined" "$suffix"
  exit 0
}

# --- read_payload_field ---
# Extracts a field from PAYLOAD by dotted path. Returns "" on missing/error.
# Handles root-level (tool_name) and nested (tool_input.command) paths.
# Usage: VAL=$(read_payload_field "tool_input.command")
read_payload_field() {
  local field_path="$1"
  echo "$PAYLOAD" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in '$field_path'.split('.'):
    if isinstance(d, dict):
        d = d.get(p, '')
    else:
        d = ''
        break
print('' if isinstance(d, (dict, list)) else d)
" 2>/dev/null || echo ""
}

# --- read_json_field ---
# Reads a single field from a JSON file. Returns "" if file missing or error.
# Stringifies scalars (int 0 → "0", bool → "True"/"False").
# Usage: VAL=$(read_json_field "/path/to/file.json" "verdict")
read_json_field() {
  local file="$1"
  local field="$2"
  if [[ ! -f "$file" ]]; then
    echo ""
    return
  fi
  python3 -c "
import json
try:
    val = json.load(open('$file')).get('$field', '')
    print('' if isinstance(val, (dict, list)) else val)
except:
    print('')
" 2>/dev/null || echo ""
}

# --- extract_write_content ---
# Sets globals TOOL_NAME and CONTENT from Write or Edit payload.
# Must be called after parse_payload.
# shellcheck disable=SC2034
extract_write_content() {
  TOOL_NAME=$(read_payload_field "tool_name")
  CONTENT=""
  if [[ "$TOOL_NAME" == "Write" ]]; then
    CONTENT=$(read_payload_field "tool_input.content")
  elif [[ "$TOOL_NAME" == "Edit" ]]; then
    CONTENT=$(read_payload_field "tool_input.new_string")
  fi
}

# --- handle_validation ---
# Processes VALIDATION result from python3 content checks.
# OK → return, PARSE_ERROR → exit 0 (fail open), FAIL:... → deny with detail.
# Usage: handle_validation "$VALIDATION" "Gate name" "Suffix message."
handle_validation() {
  local result="$1"
  local gate_name="$2"
  local suffix="${3:-}"
  if [[ "$result" == "PARSE_ERROR" ]]; then
    exit 0
  fi
  if [[ "$result" == FAIL:* ]]; then
    local detail="${result#FAIL:}"
    deny "${gate_name} blocked: ${detail}. ${suffix}"
  fi
}

# --- normalize_states ---
# Reads completed_states from a context JSON file. Normalizes all entries
# to strings (int 0 → "0", mixed types handled). Outputs space-separated list.
# Returns empty string if file missing, field absent, or parse error.
# Usage: STATES=$(normalize_states "/path/to/context.json")
normalize_states() {
  local ctx_file="$1"
  [[ ! -f "$ctx_file" ]] && { echo ""; return; }
  python3 -c "
import json
try:
    d = json.load(open('$ctx_file'))
    print(' '.join(str(s) for s in d.get('completed_states', [])))
except: print('')
" 2>/dev/null || echo ""
}

# --- get_required_states ---
# Reads _required_states array from agent_gates[$SKILL] in state-registry.json.
# Returns space-separated list of state IDs. Empty string if skill or key missing.
# Usage: REQUIRED=$(get_required_states "bootstrap")
get_required_states() {
  local skill="$1"
  local registry="${CLAUDE_PROJECT_DIR:-.}/.claude/patterns/state-registry.json"
  [[ ! -f "$registry" ]] && { echo ""; return; }
  python3 -c "
import json
d = json.load(open('$registry'))
rs = d.get('agent_gates',{}).get('$skill',{}).get('_required_states',[])
print(' '.join(str(s) for s in rs))
" 2>/dev/null || echo ""
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

# --- validate_merge_json ---
# Parameterized JSON validation for merge gate hooks. Reads merge content from stdin.
# Parses merge content, loads traces, compares fields per check definitions.
# Returns "OK", "PARSE_ERROR", or "FAIL:<details>" — caller passes to handle_validation.
# $1: check definitions JSON string (declarative field comparisons)
# Usage: VALIDATION=$(echo "$CONTENT" | validate_merge_json "$CHECK_DEFS")
validate_merge_json() {
  local check_defs="$1"
  python3 -c "
import json, sys, os

content = sys.stdin.read().strip()
errors = []

try:
    merge = json.loads(content)
except json.JSONDecodeError:
    print('PARSE_ERROR')
    sys.exit(0)

traces_dir = os.environ.get('CLAUDE_PROJECT_DIR', '.') + '/.claude/agent-traces'
checks = json.loads('''$check_defs''')

for trace_def in checks.get('traces', []):
    trace_path = os.path.join(traces_dir, trace_def['trace_file'])
    if not os.path.exists(trace_path):
        errors.append(trace_def.get('missing_error', trace_def['trace_file'] + ' not found'))
        continue
    try:
        trace = json.load(open(trace_path))
    except (json.JSONDecodeError, IOError):
        continue

    merge_key = trace_def.get('merge_key')
    merge_section = merge.get(merge_key, {}) if merge_key else merge

    for fdef in trace_def.get('fields', []):
        t_val = trace.get(fdef['trace_field'])
        m_val = merge_section.get(fdef['merge_field'])
        if fdef.get('null_ok') and (t_val is None or m_val is None):
            continue
        if t_val != m_val:
            prefix = (merge_key + '.') if merge_key else ''
            errors.append(f'{prefix}{fdef[\"merge_field\"]} mismatch: trace={t_val}, merge={m_val}')

    for sub in trace_def.get('sub_traces', []):
        sub_path = os.path.join(traces_dir, sub['trace_file'])
        if sub.get('condition') == 'exists' and not os.path.exists(sub_path):
            continue
        try:
            sub_trace = json.load(open(sub_path))
        except (json.JSONDecodeError, IOError):
            continue
        for fdef in sub.get('fields', []):
            t_val = sub_trace.get(fdef['trace_field'])
            m_val = merge_section.get(fdef['merge_field'])
            if fdef.get('null_ok') and (t_val is None or m_val is None):
                continue
            if t_val != m_val:
                prefix = (merge_key + '.') if merge_key else ''
                errors.append(f'{prefix}{fdef[\"merge_field\"]} mismatch: trace={t_val}, merge={m_val}')

for sc in checks.get('self_checks', []):
    if sc['type'] == 'count_match':
        arr = merge.get(sc['array_field'], [])
        count = merge.get(sc['count_field'], 0)
        if count != len(arr):
            errors.append(f'{sc[\"count_field\"]} ({count}) != len({sc[\"array_field\"]}) ({len(arr)})')

if errors:
    print('FAIL:' + '; '.join(errors))
else:
    print('OK')
" 2>/dev/null || echo "OK"
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
  if [[ ! -f "$TRACE_FILE" ]] || [[ ! -f "$PROJECT_DIR/.claude/verify-context.json" ]]; then
    return 0
  fi
  local RESULT
  RESULT=$(python3 -c "
import json
ctx = json.load(open('$PROJECT_DIR/.claude/verify-context.json'))
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

# --- check_postcondition_artifacts ---
# Verifies that postcondition artifact files exist for a given verify state.
# Appends to global ERRORS for any missing artifacts.
# Usage: check_postcondition_artifacts 0
check_postcondition_artifacts() {
  local PREV_STATE="$1"
  local V_SCOPE V_ARCH
  case "$PREV_STATE" in
    0)
      [[ -f "$PROJECT_DIR/.claude/verify-context.json" ]] || ERRORS+=("verify-context.json missing — STATE 0 incomplete")
      [[ -f "$PROJECT_DIR/.claude/fix-log.md" ]] || ERRORS+=("fix-log.md missing — STATE 0 incomplete")
      [[ -d "$TRACES_DIR" ]] || ERRORS+=("agent-traces/ directory missing — STATE 0 incomplete")
      ;;
    3)
      V_SCOPE=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "scope")
      V_ARCH=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "archetype")
      if [[ ("$V_SCOPE" == "full" || "$V_SCOPE" == "visual") && "$V_ARCH" == "web-app" ]]; then
        [[ -f "$PROJECT_DIR/.claude/design-ux-merge.json" ]] || ERRORS+=("design-ux-merge.json missing — STATE 3 incomplete")
      fi
      ;;
    4)
      V_SCOPE=$(read_json_field "$PROJECT_DIR/.claude/verify-context.json" "scope")
      if [[ "$V_SCOPE" == "full" || "$V_SCOPE" == "security" ]]; then
        [[ -f "$PROJECT_DIR/.claude/security-merge.json" ]] || ERRORS+=("security-merge.json missing — STATE 4 incomplete")
      fi
      ;;
  esac
}

# --- check_tier1_retry_complete ---
# Checks that tier-1 agent traces have completed retry if needed.
# Appends to global ERRORS if an agent exhausted turns without retry.
# Usage: check_tier1_retry_complete "design-critic-*" "$TRACES_DIR"
check_tier1_retry_complete() {
  local AGENT_PATTERN="$1"
  local TDIR="$2"
  for TRACE in "$TDIR"/${AGENT_PATTERN}.json; do
    [ -f "$TRACE" ] || continue
    local STATE
    STATE=$(python3 -c "
import json
d = json.load(open('$TRACE'))
has_verdict = 'verdict' in d
retry = d.get('retry_attempted', False)
status = d.get('status', '')
if has_verdict: print('COMPLETE')
elif status in ('started','exhausted') and not has_verdict and not retry: print('NEEDS_RETRY')
else: print('OK')
" 2>/dev/null || echo "OK")
    if [ "$STATE" = "NEEDS_RETRY" ]; then
      ERRORS+=("$(basename "$TRACE") exhausted without retry — must retry before proceeding")
    fi
  done
}

# --- check_efficiency_directives ---
# Validates that an agent prompt contains required efficiency directives.
# Appends to global ERRORS if directives are missing.
# Requires global PAYLOAD (raw hook payload) and PROJECT_DIR.
# Usage: check_efficiency_directives
check_efficiency_directives() {
  if [ -f "$PROJECT_DIR/.claude/verify-context.json" ]; then
    local PROMPT
    PROMPT=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d.get('tool_input',{}).get('prompt',''))
" <<< "$PAYLOAD" 2>/dev/null || echo "")
    if ! echo "$PROMPT" | grep -q "DIRECTIVES:batch_search,pr_changed_first,context_digest,pre_existing"; then
      ERRORS+=("Agent prompt missing efficiency directives — append .claude/agent-prompt-footer.md content")
    fi
  fi
}

# --- check_build_result ---
# Checks that build-result.json exists and has exit_code 0.
# Appends to global ERRORS if missing or non-zero.
# Usage: check_build_result
check_build_result() {
  local BR_FILE="$PROJECT_DIR/.claude/build-result.json"
  if [[ ! -f "$BR_FILE" ]]; then
    ERRORS+=("build-result.json missing — STATE 1 (Build & Lint Loop) did not record its result")
    return
  fi
  local EXIT_CODE
  EXIT_CODE=$(read_json_field "$BR_FILE" "exit_code")
  if [[ "$EXIT_CODE" != "0" ]]; then
    ERRORS+=("build-result.json exit_code=$EXIT_CODE — build did not pass (STATE 1 incomplete)")
  fi
}

# --- check_file_boundary ---
# Validates that a per-page agent prompt contains FILE_BOUNDARY markers
# and does not include shared paths (src/components/, src/lib/).
# Appends to global ERRORS on violations. Requires global PAYLOAD.
# Usage: check_file_boundary "design-critic (per-page)"
check_file_boundary() {
  local AGENT_NAME="$1"
  local PROMPT
  PROMPT=$(python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
print(d.get('tool_input',{}).get('prompt',''))
" <<< "$PAYLOAD" 2>/dev/null || echo "")

  local BOUNDARY_RESULT
  BOUNDARY_RESULT=$(python3 -c "
import re, sys
prompt = sys.stdin.read()
m = re.search(r'FILE_BOUNDARY_START\n(.*?)FILE_BOUNDARY_END', prompt, re.DOTALL)
if not m:
    print('NO_MARKER')
else:
    files = m.group(1).strip()
    shared = [f for f in files.split('\n') if f.strip().startswith('src/components/') or f.strip().startswith('src/lib/')]
    if shared:
        print('SHARED:' + ';'.join(shared[:3]))
    else:
        print('OK')
" <<< "$PROMPT" 2>/dev/null || echo "OK")

  if [[ "$BOUNDARY_RESULT" == "NO_MARKER" ]]; then
    ERRORS+=("$AGENT_NAME prompt missing FILE_BOUNDARY marker — per-page agents must declare their file boundary")
  elif [[ "$BOUNDARY_RESULT" == SHARED:* ]]; then
    local SHARED_FILES="${BOUNDARY_RESULT#SHARED:}"
    ERRORS+=("$AGENT_NAME FILE_BOUNDARY contains shared paths ($SHARED_FILES) — per-page agents must NOT include src/components/ or src/lib/")
  fi
}

# --- _parse_check_result ---
# Parses JSON {"errors":[...],"warnings":[...]} from check functions.
# Appends to global ERRORS and WARNINGS arrays.
# Usage: _parse_check_result "$RESULT"
_parse_check_result() {
  local result="$1"
  [[ "$result" == "OK" || -z "$result" ]] && return
  while IFS= read -r line; do
    [[ -n "$line" ]] && ERRORS+=("$line")
  done < <(echo "$result" | python3 -c "import json,sys; [print(x) for x in json.load(sys.stdin).get('errors',[])]" 2>/dev/null)
  while IFS= read -r line; do
    [[ -n "$line" ]] && WARNINGS+=("$line")
  done < <(echo "$result" | python3 -c "import json,sys; [print(x) for x in json.load(sys.stdin).get('warnings',[])]" 2>/dev/null)
}

# --- check_artifact_presence ---
# Table-driven artifact existence checks for verify-report-gate.
# Covers Checks 1-7, 13b, 15: file existence, field validation, trace checks.
# Returns JSON {"errors":[...],"warnings":[...]} — caller uses _parse_check_result.
# $1: project directory  $2: has_hard_gate (0|1)  $3: report content
# Usage: RESULT=$(check_artifact_presence "$PROJECT_DIR" "$HAS_HARD_GATE" "$CONTENT")
check_artifact_presence() {
  local has_hard_gate="$2"
  echo "$3" | HAS_HARD_GATE="$has_hard_gate" python3 -c "
import json, os, glob, sys

project = os.environ.get('CLAUDE_PROJECT_DIR', '.')
hard_gate = int(os.environ.get('HAS_HARD_GATE', '0')) > 0
content = sys.stdin.read()
errors = []
warnings = []

# --- Check 1: verify-context.json exists + field validation ---
ctx_path = os.path.join(project, '.claude/verify-context.json')
ctx = {}
if not os.path.exists(ctx_path):
    errors.append('verify-context.json not found — STATE 0 (Read Context) did not run')
else:
    try:
        ctx = json.load(open(ctx_path))
        missing = [k for k in ['scope','archetype','run_id','timestamp'] if k not in ctx or not ctx[k]]
        if missing:
            errors.append('verify-context.json missing required fields: ' + ','.join(missing))
    except:
        errors.append('verify-context.json parse error')

scope = ctx.get('scope', '')
arch = ctx.get('archetype', '')

# --- Check 2: fix-log.md exists ---
fix_log_path = os.path.join(project, '.claude/fix-log.md')
if not os.path.exists(fix_log_path):
    errors.append('fix-log.md not found — STATE 0 (Read Context) did not run')

# --- Check 3: agent-traces/ has >= 1 trace ---
traces_dir = os.path.join(project, '.claude/agent-traces')
traces = []
if not os.path.isdir(traces_dir):
    errors.append('agent-traces/ directory not found — no agents were spawned')
else:
    traces = glob.glob(os.path.join(traces_dir, '*.json'))
    if len(traces) < 1:
        errors.append('agent-traces/ has 0 trace files — no agents completed')

# --- Check 4: Each trace has checks_performed ---
for t in traces:
    try:
        d = json.load(open(t))
        cp = d.get('checks_performed', None)
        recovery = d.get('recovery', False)
        if recovery and isinstance(cp, list): continue
        if isinstance(cp, list) and len(cp) > 0: continue
        errors.append(os.path.basename(t) + ' missing checks_performed array — agent used old trace format')
    except:
        errors.append(os.path.basename(t) + ' parse error')

# --- Check 5: security-merge.json (skip on hard gate) ---
if not hard_gate and scope in ('full', 'security'):
    if not os.path.exists(os.path.join(project, '.claude/security-merge.json')):
        errors.append('security-merge.json not found — security merge step was skipped (scope=' + scope + ')')

# --- Check 6: fix-log vs auto_observe (skip on hard gate) ---
if not hard_gate and os.path.exists(fix_log_path):
    try:
        lines = open(fix_log_path).readlines()[1:]  # skip header
        fix_entries = sum(1 for l in lines if l.strip())
        if fix_entries > 0 and 'auto_observe' in content and 'skipped-no-fixes' in content:
            errors.append('fix-log.md has ' + str(fix_entries) + ' fix entries but auto_observe is skipped-no-fixes — observer must run when fixes exist')
    except: pass

# --- Check 7: e2e-result.json (skip on hard gate) ---
if not hard_gate:
    e2e_path = os.path.join(project, '.claude/e2e-result.json')
    if not os.path.exists(e2e_path):
        errors.append('e2e-result.json not found — E2E tests (STATE 5) did not run')
    else:
        try:
            e2e = json.load(open(e2e_path))
            if not e2e.get('passed', False):
                warnings.append('e2e-result.json: passed=false — E2E tests failed')
        except: pass

# --- Check 13b: design-critic-shared when per-page has unresolved_shared ---
if scope in ('full', 'visual') and arch == 'web-app':
    has_shared = False
    for f in glob.glob(os.path.join(traces_dir, 'design-critic-*.json')):
        if 'design-critic-shared' in f: continue
        try:
            d = json.load(open(f))
            if d.get('unresolved_shared', 0) > 0:
                has_shared = True; break
        except: pass
    if has_shared and not os.path.exists(os.path.join(traces_dir, 'design-critic-shared.json')):
        errors.append('design-critic-shared.json missing but per-page agents reported shared-component issues')

# --- Check 15: Postcondition artifact backstop ---
for f in ['verify-context.json', 'fix-log.md']:
    if not os.path.exists(os.path.join(project, '.claude', f)):
        errors.append(f + ' missing (STATE 0)')
if not os.path.exists(os.path.join(project, '.claude/build-result.json')):
    errors.append('build-result.json missing (STATE 1)')
if scope in ('full', 'visual') and arch == 'web-app':
    if not os.path.exists(os.path.join(project, '.claude/design-ux-merge.json')):
        errors.append('design-ux-merge.json missing (STATE 3)')
if not hard_gate:
    if scope in ('full', 'security'):
        if not os.path.exists(os.path.join(project, '.claude/security-merge.json')):
            errors.append('security-merge.json missing (STATE 4)')
    if not os.path.exists(os.path.join(project, '.claude/e2e-result.json')):
        errors.append('e2e-result.json missing (STATE 5)')

print(json.dumps({'errors': errors, 'warnings': warnings}))
" 2>/dev/null || echo "OK"
}

# --- check_cross_artifact_consistency ---
# Cross-artifact consistency checks for verify-report-gate.
# Covers Checks 12, 14, 16-19: verdict matching, fix counts, frontmatter, Q-score.
# Returns JSON {"errors":[...],"warnings":[...]} — caller uses _parse_check_result.
# $1: project directory  $2: report content
# Usage: RESULT=$(check_cross_artifact_consistency "$PROJECT_DIR" "$CONTENT")
check_cross_artifact_consistency() {
  echo "$2" | python3 -c "
import json, os, glob, re, sys

project = os.environ.get('CLAUDE_PROJECT_DIR', '.')
content = sys.stdin.read()
traces_dir = os.path.join(project, '.claude/agent-traces')
errors = []
warnings = []

# --- Check 12: agent_verdicts in report vs actual trace verdicts ---
match = re.search(r'agent_verdicts:\s*(.+)', content)
if match and os.path.isdir(traces_dir):
    try:
        report_verdicts = json.loads(match.group(1).strip())
        for name, rv in report_verdicts.items():
            tp = os.path.join(traces_dir, name + '.json')
            if os.path.exists(tp):
                try:
                    tv = json.load(open(tp)).get('verdict', 'missing')
                    if str(rv) != str(tv):
                        errors.append('agent_verdicts mismatch: ' + name + ': report=' + str(rv) + ', trace=' + str(tv))
                except: pass
    except json.JSONDecodeError:
        pass

# --- Check 14: Fix count cross-reference (WARN only) ---
fix_log_path = os.path.join(project, '.claude/fix-log.md')
if os.path.isdir(traces_dir) and os.path.exists(fix_log_path):
    try:
        fix_log = open(fix_log_path).read()
        prefix_map = {
            'design-critic': 'Fix (design-critic):',
            'ux-journeyer': 'Fix (ux-journeyer):',
            'security-fixer': 'Fix (security-fixer):'
        }
        for tf in glob.glob(os.path.join(traces_dir, '*.json')):
            name = os.path.basename(tf).replace('.json', '')
            if name.startswith('design-critic-'): continue
            try:
                d = json.load(open(tf))
                fixes = d.get('fixes', None)
                if fixes is None: continue
                prefix = prefix_map.get(name, 'Fix (' + name + '):')
                if len(fixes) != fix_log.count(prefix):
                    warnings.append(name + ': trace=' + str(len(fixes)) + ', log=' + str(fix_log.count(prefix)))
            except: pass
    except: pass

# --- Check 16: hard_gate_failure field present ---
if content and 'hard_gate_failure:' not in content:
    errors.append('hard_gate_failure field missing from report frontmatter — must be true or false')

# --- Check 17: process_violation field present ---
if content and 'process_violation:' not in content:
    errors.append('process_violation field missing from report frontmatter — must be true or false')

# --- Check 18: Lead-side trace field validation ---
dc_path = os.path.join(traces_dir, 'design-critic.json')
if os.path.exists(dc_path):
    try:
        d = json.load(open(dc_path))
        pr = d.get('pages_reviewed', 0)
        if not isinstance(pr, int) or pr < 1:
            errors.append('design-critic pages_reviewed=%s (expected int >= 1)' % pr)
    except: pass
ux_path = os.path.join(traces_dir, 'ux-journeyer.json')
if os.path.exists(ux_path):
    try:
        d = json.load(open(ux_path))
        ude = d.get('unresolved_dead_ends', None)
        if ude is not None and not isinstance(ude, int):
            errors.append('ux-journeyer unresolved_dead_ends=%s (expected int)' % ude)
    except: pass
sf_path = os.path.join(traces_dir, 'security-fixer.json')
if os.path.exists(sf_path):
    try:
        d = json.load(open(sf_path))
        uc = d.get('unresolved_critical', None)
        if uc is not None and not isinstance(uc, int):
            errors.append('security-fixer unresolved_critical=%s (expected int)' % uc)
    except: pass

# --- Check 19: Q-score in verify-history.jsonl ---
ctx_path = os.path.join(project, '.claude/verify-context.json')
if os.path.exists(ctx_path):
    try:
        run_id = json.load(open(ctx_path)).get('run_id', '')
        hist_path = os.path.join(project, '.claude/verify-history.jsonl')
        if not os.path.exists(hist_path):
            errors.append('verify-history.jsonl missing — Q-score not calculated')
        else:
            lines = [l.strip() for l in open(hist_path) if l.strip()]
            if not lines:
                errors.append('verify-history.jsonl is empty — Q-score not recorded')
            else:
                last = json.loads(lines[-1])
                if last.get('run_id') != run_id:
                    errors.append('verify-history.jsonl last run_id (' + str(last.get('run_id','?')) + ') != current (' + run_id + ') — Q-score not recorded for this run')
    except: pass

print(json.dumps({'errors': errors, 'warnings': warnings}))
" 2>/dev/null || echo "OK"
}

# --- rerun_postconditions ---
# Re-runs all postcondition commands from state-registry.json for a given skill.
# Skips states whose command is "true" (no artifact to check).
# Appends failures to global ERRORS array. Does not exit — caller decides.
# Returns 0 if all pass, 1 if any fail.
# Usage: rerun_postconditions "change"
rerun_postconditions() {
  local skill="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local registry="$project_dir/.claude/patterns/state-registry.json"
  [[ ! -f "$registry" ]] && return 0

  local state_cmds
  state_cmds=$(python3 -c "
import json
reg = json.load(open('$registry'))
skill_data = reg.get('$skill', {})
for state_id, cmd in skill_data.items():
    if isinstance(cmd, str) and cmd.strip() != 'true':
        print(state_id + '\t' + cmd)
" 2>/dev/null || echo "")

  [[ -z "$state_cmds" ]] && return 0

  local had_failure=0
  while IFS=$'\t' read -r state_id cmd; do
    if ! (cd "$project_dir" && eval "$cmd") >/dev/null 2>&1; then
      ERRORS+=("STATE $state_id postcondition failed: $cmd")
      had_failure=1
    fi
  done <<< "$state_cmds"

  return "$had_failure"
}

# --- check_block_verdicts ---
# Checks gate-verdicts/ for any BLOCK verdicts on the current branch.
# Appends blocking gate IDs to global ERRORS array. Does not exit — caller decides.
# Usage: check_block_verdicts
check_block_verdicts() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local verdicts_dir="$project_dir/.claude/gate-verdicts"
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
