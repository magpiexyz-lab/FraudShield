#!/usr/bin/env bash
# state-completion-gate.sh — Claude Code PreToolUse hook for Bash commands.
# Validates state postconditions before allowing completed_states updates.
# Works with advance-state.sh: when the LLM marks a state complete, this hook
# checks that the state's postcondition artifacts actually exist on disk.
# Supports all skills via per-skill registry in state-registry.json.
set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

COMMAND=$(read_payload_field "tool_input.command")

# Only fire on actual advance-state.sh invocations at command-head position
# (#1223). Naive substring grep fired on script names appearing inside heredoc
# bodies, --body arguments, and quoted strings — the helper strips heredocs,
# shlex-tokenizes, and only matches at command-head positions. Fails open on
# parse errors so the gate never silently flips to fail-closed (issue #1223).
_PROJECT_DIR_GATE="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo .)}"
_INVOCATION_HELPER="$_PROJECT_DIR_GATE/.claude/scripts/lib/check-advance-state-invocation.py"
if [[ ! -f "$_INVOCATION_HELPER" ]]; then
  # Helper missing — fall back to the legacy grep so we do not over-block.
  if ! printf '%s' "$COMMAND" | grep -qE 'bash\s+\S*advance-state\.sh\s'; then
    exit 0
  fi
  parse_advance_state_args
else
  if ! printf '%s' "$COMMAND" | python3 "$_INVOCATION_HELPER"; then
    exit 0
  fi
  SKILL=$(printf '%s' "$COMMAND" | python3 "$_INVOCATION_HELPER" --print-skill)
  STATE_ID=$(printf '%s' "$COMMAND" | python3 "$_INVOCATION_HELPER" --print-state-id)
fi

if [[ -z "$SKILL" || -z "$STATE_ID" ]]; then
  exit 0
fi

# Format validation: SKILL and STATE_ID must be safe shell-injection-free identifiers.
# Reject malformed input (kept as defense-in-depth; the helper's tokenization
# normally guarantees well-formed values, but a future caller could still pass
# garbage args).
if ! [[ "$SKILL" =~ ^[a-z][a-z0-9_-]*$ && "$STATE_ID" =~ ^[0-9]+[a-z]?$ ]]; then
  deny "State completion gate: malformed args SKILL='$SKILL' STATE_ID='$STATE_ID'. Run advance-state.sh with one skill/state per Bash call (do not chain with &&)."
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
REGISTRY="$PROJECT_DIR/.claude/patterns/state-registry.json"

if [[ ! -f "$REGISTRY" ]]; then
  deny "State registry missing: $REGISTRY. Cannot verify postconditions for $SKILL STATE $STATE_ID. Restore from git (\`git checkout main -- .claude/patterns/state-registry.json\`) or run /upgrade to sync template."
fi

# --- BLOCK verdict check: deny state advancement if any gate has BLOCK on this branch ---
VERDICTS_DIR="$PROJECT_DIR/.runs/gate-verdicts"
if [[ -d "$VERDICTS_DIR" ]]; then
  BRANCH=$(get_branch)
  for gf in "$VERDICTS_DIR"/*.json; do
    [[ -f "$gf" ]] || continue
    gv=$(read_json_field "$gf" "verdict")
    [[ "$gv" != "BLOCK" ]] && continue
    gvb=$(read_json_field "$gf" "branch")
    if [[ "$gvb" == "$BRANCH" ]]; then
      gate_id=$(basename "$gf" .json)
      deny "Gate $gate_id has BLOCK verdict. Fix blocking items and re-run gate-keeper before advancing."
    fi
  done
fi

# Look up VERIFY command for this skill + state (nested lookup — keep inline)
# Supports both string format ("test -f ...") and object format ({"verify": "...", "calls": [...]})
ENTRY_DATA=$(python3 -c "
import json
reg = json.load(open('$REGISTRY'))
entry = reg.get('$SKILL', {}).get('$STATE_ID', '')
if isinstance(entry, dict):
    print(entry.get('verify', '') + '\t' + json.dumps(entry.get('calls', [])))
else:
    print(str(entry) + '\t')
" 2>&1) || {
  deny "State registry parse error: cannot read $REGISTRY for $SKILL STATE $STATE_ID. Output: $ENTRY_DATA. Fix the JSON syntax or restore from git."
}

VERIFY_CMD=$(printf '%s' "$ENTRY_DATA" | cut -f1)
CALLS_JSON=$(printf '%s' "$ENTRY_DATA" | cut -f2)

# --- Chain check: verify all prior states are in completed_states ---
# This prevents skipping states (e.g., jumping from STATE 0 to STATE 3).
# Uses registry key order as the canonical state sequence.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
source "$_SCRIPT_DIR/lifecycle-lib.sh"
CTX_FILE=$(resolve_context_path "$SKILL")

# --- Identity cross-check (issue #941 defense-in-depth) ---
# $SKILL is authoritative (from advance-state.sh args). When the active
# identity from resolve_active_identity disagrees, warn — it indicates a
# stale or crossed context that should be investigated, but don't block
# (the chain check / VERIFY command below are the real gates).
ACTIVE_IDENTITY="$(resolve_active_identity)"
if [[ -n "$ACTIVE_IDENTITY" ]]; then
  IFS=$'\t' read -r _SCG_ACTIVE_SKILL _ _ _ <<< "$ACTIVE_IDENTITY"
  if [[ -n "$_SCG_ACTIVE_SKILL" && "$_SCG_ACTIVE_SKILL" != "$SKILL" ]]; then
    echo "WARN: state-completion-gate: args-skill='$SKILL' but resolve_active_identity returned '$_SCG_ACTIVE_SKILL' — possible stale context" >&2
  fi
  unset _SCG_ACTIVE_SKILL
fi

# --- _log_verify_trace ---
# Append a verify pass/fail entry to the execution trace.
# Args: <skill> <state_id> <result> [verify_cmd]
_log_verify_trace() {
  local skill="$1" state_id="$2" result="$3" verify_cmd="${4:-}"
  python3 -c "
import json, os, datetime
try:
    ctx_path = '$CTX_FILE'
    run_id = json.load(open(ctx_path)).get('run_id', 'unknown') if os.path.exists(ctx_path) else 'unknown'
    trace_file = '.runs/${skill}-execution-trace.jsonl'
    is_first = True
    if os.path.exists(trace_file):
        with open(trace_file) as f:
            for line in f:
                try:
                    e = json.loads(line)
                    if e.get('run_id') == run_id and e.get('state_id') == '$state_id':
                        is_first = False
                        break
                except: pass
    os.makedirs('.runs', exist_ok=True)
    entry = {
        'run_id': run_id,
        'skill': '$skill',
        'state_id': '$state_id',
        'timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'verify_result': '$result',
        'is_first_attempt': is_first
    }
    verify_cmd = '''$verify_cmd'''
    if verify_cmd:
        entry['verify_cmd'] = verify_cmd
    with open(trace_file, 'a') as f:
        f.write(json.dumps(entry) + '\n')
except: pass
" 2>/dev/null || true
}

if [[ -f "$CTX_FILE" ]]; then
  CHAIN_RESULT=$(python3 -c "
import json, sys
reg = json.load(open('$REGISTRY'))
ctx = json.load(open('$CTX_FILE'))
cs = [str(s) for s in ctx.get('completed_states', [])]
skip = set(str(s) for s in ctx.get('skip_states', []))
states = list(reg.get('$SKILL', {}).keys())
cur = '$STATE_ID'
if cur in states:
    idx = states.index(cur)
    missing = [s for s in states[:idx] if s not in cs and s not in skip]
    if missing:
        print(','.join(missing))
else:
    print('UNREGISTERED')
" 2>/dev/null || echo "")

  if [[ "$CHAIN_RESULT" == "UNREGISTERED" ]]; then
    deny "State completion gate: $SKILL STATE $STATE_ID — not in state-registry.json. Register before advancing."
  elif [[ -n "$CHAIN_RESULT" ]]; then
    deny "State completion gate: $SKILL STATE $STATE_ID — prior states not complete: [$CHAIN_RESULT]. Complete earlier states before advancing."
  fi
fi

# --- Artifact check: run VERIFY command from registry ---
if [[ "$VERIFY_CMD" == "true" ]]; then
  exit 0  # Intentional no-check (explicitly registered as "true")
fi

if [[ -z "$VERIFY_CMD" ]]; then
  deny "State completion gate: $SKILL STATE $STATE_ID — no VERIFY in registry. Add postcondition entry before advancing."
fi

# Run the verify command from project root
cd "$PROJECT_DIR"
if ! eval "$VERIFY_CMD" >/dev/null 2>&1; then
  # Trace: log VERIFY failure
  _log_verify_trace "$SKILL" "$STATE_ID" "fail" "$VERIFY_CMD"
  deny "State completion gate: $SKILL STATE $STATE_ID postconditions not met. VERIFY failed: $VERIFY_CMD — complete this state's actions before marking it done."
fi

# --- Calls artifact check: verify each call's artifact exists ---
if [[ -n "$CALLS_JSON" && "$CALLS_JSON" != "[]" ]]; then
  MISSING_ARTIFACTS=$(printf '%s' "$CALLS_JSON" | python3 -c "
import json, os, sys
calls = json.load(sys.stdin)
missing = []
for c in calls:
    art = c.get('artifact', '')
    if art and not os.path.isfile(art):
        missing.append(art + ' (required by ' + c.get('path', '?') + ')')
if missing:
    print('; '.join(missing))
" 2>/dev/null || echo "")

  if [[ -n "$MISSING_ARTIFACTS" ]]; then
    deny "State completion gate: $SKILL STATE $STATE_ID postconditions not met. Missing call artifacts: $MISSING_ARTIFACTS"
  fi
fi

# ── Universal spawn provenance check ──
# For each completed trace in agent-traces/, verify a matching spawn record
# exists in agent-spawn-log.jsonl. Excludes recovery traces, started-only
# traces, merge artifacts, and non-manifest agents.
# This is the Option B universal check — works for ALL skills, zero config.
SPAWN_LOG="$PROJECT_DIR/.runs/agent-spawn-log.jsonl"
_SCG_MANIFEST=$(resolve_framework_manifest "$SKILL")
if [[ -f "$SPAWN_LOG" && -f "$_SCG_MANIFEST" ]]; then
  PROVENANCE_RESULT=$(python3 -c "
import json, glob, os, sys

# #1256: Sanctioned coverage_provider allowlist for lead-synthesized aggregates
# whose corresponding agents were never spawned (Stage 0 fast-path). Mirrors
# SANCTIONED_DEGRADED_REASONS in merge-design-critic-traces.py:44 — adding a
# new path: append here AND document in agent-output-contract.md. The exemption
# at the per-trace check below skips the no-spawn-record error for traces with
# provenance='lead-synthesized' AND coverage_provider in this set.
SANCTIONED_COVERAGE_PROVIDERS = frozenset({
    '.runs/all-pages-fast-path-decision.json',
})

manifest = json.load(open('$_SCG_MANIFEST'))
declared = set(manifest.get('agents', {}).keys())
if not declared:
    sys.exit(0)  # No agents declared in manifest

# Get current run_id to filter stale spawn records from prior runs
ctx_path = os.path.join('$PROJECT_DIR', '.runs', '$SKILL' + '-context.json')
current_run_id = ''
try:
    current_run_id = json.load(open(ctx_path)).get('run_id', '')
except: pass

# Collect spawned agent base names from hook-written spawn-log
# Only count entries matching the current run_id
spawned = set()
with open('$SPAWN_LOG') as f:
    for line in f:
        try:
            e = json.loads(line)
            if e.get('hook') in ('skill-agent-gate', 'recovery-script'):
                if not current_run_id or e.get('run_id') == current_run_id:
                    spawned.add(e['agent'])
        except: pass

# Check each trace file for provenance
errors = []
traces_dir = os.path.join('$PROJECT_DIR', '.runs', 'agent-traces')
for tf in sorted(glob.glob(os.path.join(traces_dir, '*.json'))):
    try:
        td = json.load(open(tf))
    except: continue
    agent_name = td.get('agent', '')
    if not agent_name: continue
    # Skip started-only init traces (no verdict yet)
    if td.get('status') == 'started' and 'verdict' not in td: continue
    # NOTE: recovery traces are NO LONGER skipped here (issue #960 fix).
    # Recovery is now an audit marker, not a spawn-check bypass: recovery
    # traces require a real skill-agent-gate spawn-log entry (per
    # write-recovery-trace.sh preconditions), so they SHOULD pass the
    # universal provenance check below. Semantic validity of a recovery
    # trace is owned by verify-report-gate.sh / validate-recovery.sh.
    # See also the lead-merge exemption in the "base == bn" block below.
    # Skip traces from prior runs (stale run_id)
    trace_run_id = td.get('run_id', '')
    if current_run_id and trace_run_id and trace_run_id != current_run_id: continue

    # Resolve base agent name (e.g., design-critic-landing -> design-critic)
    base = agent_name
    bn = os.path.basename(tf).replace('.json', '')
    for da in sorted(declared, key=len, reverse=True):
        if agent_name == da or bn.startswith(da + '-'):
            base = da
            break

    # Only check manifest-declared agents
    if base not in declared: continue

    # Lead-merge aggregate exemption (now explicit via provenance — R2 C3/C7 fix).
    # When a trace filename equals a declared base agent AND sibling <base>-*.json
    # files exist, this is an orchestrator-composed aggregate (verify STATE 3b
    # merges per-page design-critic-<page>.json into design-critic.json; same
    # shape for scaffold-pages/scaffold-images/implementer in other skills).
    # Aggregates have no direct spawn-log entry. Their validity comes from the
    # sibling spawns, not their own.
    #
    # Invariant (AOC v1.1): if provenance is declared, it MUST be one of
    # {lead-merge, lead-on-behalf} for this exemption. lead-merge is the
    # canonical aggregate composer; lead-on-behalf permits the case where
    # the lead transcribed an agent's reported aggregate result because the
    # agent's own write was blocked. Other lead-* values (lead-synthesized,
    # lead-fix) at the aggregate filename are inconsistent with the per-page
    # sibling pattern and are rejected.
    # If contributing_spawn_indexes is declared, its count must
    # equal the number of skill-agent-gate entries for this base in the
    # current run_id (prevents forged aggregates claiming non-existent spawns).
    # Legacy aggregates missing provenance/contributing_spawn_indexes are
    # accepted for backward compatibility until migration runs.
    if bn == base and glob.glob(os.path.join(traces_dir, base + '-*.json')):
        prov = td.get('provenance')
        if prov and prov not in ('lead-merge', 'lead-on-behalf'):
            errors.append(f'{bn}: aggregate trace has provenance={prov}, expected lead-merge or lead-on-behalf')
            continue
        csi = td.get('contributing_spawn_indexes')
        if isinstance(csi, list):
            # Count spawn-log entries for this base in current run_id
            expected = 0
            with open('$SPAWN_LOG') as _f:
                for _line in _f:
                    try:
                        _e = json.loads(_line)
                    except:
                        continue
                    if _e.get('agent') == base and (not current_run_id or _e.get('run_id') == current_run_id) and _e.get('hook') == 'skill-agent-gate':
                        expected += 1
            if len(csi) != expected:
                errors.append(f'{bn}: lead-merge claims {len(csi)} spawns but spawn-log has {expected} for {base} in current run')
                continue
        continue

    # Provenance check: base agent must appear in spawn-log
    if base not in spawned:
        # #1256 Stage 0 exemption: lead-synthesized aggregate from a sanctioned
        # all-pages-fast-path detector. Agent was never spawned by design — the
        # decision artifact (coverage_provider) is the proof of coverage.
        prov = td.get('provenance')
        cp = td.get('coverage_provider', '')
        if prov == 'lead-synthesized' and cp in SANCTIONED_COVERAGE_PROVIDERS:
            continue
        errors.append(f'{bn}: no spawn record for {base}')

if errors:
    print('|'.join(errors))
" 2>/dev/null || echo "")

  if [[ -n "$PROVENANCE_RESULT" ]]; then
    _log_verify_trace "$SKILL" "$STATE_ID" "fail-provenance" ""
    deny "State completion gate: $SKILL STATE $STATE_ID — trace provenance failed. Traces without Agent spawn records: ${PROVENANCE_RESULT//|/, }. You must spawn agents via the Agent tool."
  fi
fi

# Postconditions verified — allow
# Trace: log VERIFY pass
_log_verify_trace "$SKILL" "$STATE_ID" "pass"
# === Template remote + version check (only on STATE 0) ===
if [[ "$STATE_ID" == "0" ]]; then
    python3 -c "
import subprocess, sys, os
try:
    # Step 1: Ensure template remote exists
    check = subprocess.run(['git', 'remote', 'get-url', 'template'],
                           capture_output=True, text=True, timeout=2)
    if check.returncode != 0:
        # Find template repo via GitHub API
        current = subprocess.run(
            ['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
            capture_output=True, text=True, timeout=10
        ).stdout.strip()
        if current:
            info = subprocess.run(
                ['gh', 'api', f'repos/{current}',
                 '--jq', '.template_repository.full_name // .parent.full_name // empty'],
                capture_output=True, text=True, timeout=10
            ).stdout.strip()
            if info:
                subprocess.run(
                    ['git', 'remote', 'add', 'template', f'https://github.com/{info}.git'],
                    capture_output=True, timeout=5
                )

    # Step 2: Version check
    subprocess.run(['git', 'fetch', 'template', '--quiet'],
                   capture_output=True, timeout=10)
    local_hash = subprocess.run(['git', 'hash-object', 'CLAUDE.md'],
                                capture_output=True, text=True).stdout.strip()
    remote = subprocess.run(['git', 'show', 'template/main:CLAUDE.md'],
                            capture_output=True, text=True)
    if remote.returncode == 0 and remote.stdout:
        import hashlib
        blob_content = f'blob {len(remote.stdout)}\0{remote.stdout}'.encode()
        remote_hash = hashlib.sha1(blob_content).hexdigest()
        if local_hash != remote_hash:
            print('NOTE: Your template is behind upstream. '
                  'Run /upgrade to sync with the latest template.',
                  file=sys.stderr)
except Exception:
    pass
" 2>/dev/null || true
fi
exit 0
