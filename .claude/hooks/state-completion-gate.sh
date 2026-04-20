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

# Only fire on actual advance-state.sh invocations (not strings mentioning it)
if ! echo "$COMMAND" | grep -qE 'bash\s+\S*advance-state\.sh\s'; then
  exit 0
fi

parse_advance_state_args

if [[ -z "$SKILL" || -z "$STATE_ID" ]]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
REGISTRY="$PROJECT_DIR/.claude/patterns/state-registry.json"

if [[ ! -f "$REGISTRY" ]]; then
  exit 0  # Fail-open if registry missing
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
" 2>/dev/null || echo "")

VERIFY_CMD=$(printf '%s' "$ENTRY_DATA" | cut -f1)
CALLS_JSON=$(printf '%s' "$ENTRY_DATA" | cut -f2)

# --- Chain check: verify all prior states are in completed_states ---
# This prevents skipping states (e.g., jumping from STATE 0 to STATE 3).
# Uses registry key order as the canonical state sequence.
_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../scripts" && pwd)"
source "$_SCRIPT_DIR/lifecycle-lib.sh"
CTX_FILE=$(resolve_context_path "$SKILL")

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
_SCG_MANIFEST="$PROJECT_DIR/.runs/${SKILL}-manifest.json"
if [[ -f "$SPAWN_LOG" && -f "$_SCG_MANIFEST" ]]; then
  PROVENANCE_RESULT=$(python3 -c "
import json, glob, os, sys

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
    # Skip recovery traces (written by controlled script)
    if td.get('recovery'): continue
    # Skip started-only init traces (no verdict yet)
    if td.get('status') == 'started' and 'verdict' not in td: continue
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

    # Skip lead-written merge artifacts from per-item parallel fan-out.
    # Canonical example: verify STATE 3b merges per-page design-critic-<page>.json
    # traces (each individually spawned via the Agent tool, each with its own
    # spawn-log entry) into an aggregate design-critic.json written by the
    # orchestrator in code — NOT via an Agent spawn, so it carries no spawn
    # record. This exception keeps the aggregate valid provided sibling
    # <base>-*.json traces exist (each sibling already satisfies provenance).
    # Same shape applies to bootstrap state-11b scaffold-pages-<page>.json ->
    # scaffold-pages.json, and any future per-item parallel-agent merge.
    # Do NOT remove this block without updating every skill that fans out
    # per-item — otherwise every merged-aggregate trace will be rejected as
    # "no spawn record" and the skill cannot advance.
    if bn == base and glob.glob(os.path.join(traces_dir, base + '-*.json')):
        continue

    # Provenance check: base agent must appear in spawn-log
    if base not in spawned:
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
