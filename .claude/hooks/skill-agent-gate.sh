#!/usr/bin/env bash
# skill-agent-gate.sh — Universal PreToolUse hook for Agent tool.
# Manifest-driven declarative checks + convention gates + registry defense-in-depth.
# Replaces: agent-state-gate.sh (PR 5, v2 migration step 5/8).

set -euo pipefail

source "$(dirname "$0")/lib.sh"
parse_payload

SUBAGENT_TYPE=$(read_payload_field "tool_input.subagent_type")

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
TRACES_DIR="$PROJECT_DIR/.runs/agent-traces"
ERRORS=()

# ── Fast-path: no context files → no skill active → allow ──
shopt -s nullglob
CTX_FILES=("$PROJECT_DIR"/.runs/*-context.json)
shopt -u nullglob
if [[ ${#CTX_FILES[@]} -eq 0 ]]; then
  exit 0
fi

# ── Detect active skill (most recent non-completed context) ──
export _SAG_PROJECT="$PROJECT_DIR"
ACTIVE_SKILL=$(python3 -c "
import json, glob, os
project = os.environ['_SAG_PROJECT']
best_skill = ''
best_ts = ''
for f in glob.glob(os.path.join(project, '.runs', '*-context.json')):
    if 'epilogue-context' in f: continue
    try:
        d = json.load(open(f))
        if d.get('completed'): continue
        ts = d.get('timestamp', '')
        if ts > best_ts:
            best_ts = ts
            best_skill = d.get('skill', os.path.basename(f).replace('-context.json', ''))
    except: pass
print(best_skill)
" 2>/dev/null || echo "")
unset _SAG_PROJECT

if [[ -z "$ACTIVE_SKILL" ]]; then
  exit 0
fi

# ── Load manifest and check if agent is declared ──
MANIFEST="$PROJECT_DIR/.runs/${ACTIVE_SKILL}-manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  # No manifest = no active skill lifecycle — allow
  exit 0
fi

export _SAG_MANIFEST="$MANIFEST" _SAG_AGENT="$SUBAGENT_TYPE"
AGENT_IN_MANIFEST=$(python3 -c "
import json, os
m = json.load(open(os.environ['_SAG_MANIFEST']))
agents = m.get('agents', {})
print('yes' if os.environ['_SAG_AGENT'] in agents else 'no')
" 2>/dev/null || echo "no")
unset _SAG_MANIFEST _SAG_AGENT

if [[ "$AGENT_IN_MANIFEST" != "yes" ]]; then
  # Agent not declared in manifest — allow (manifest is authoritative in v2)
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════
# MANIFEST PATH
# ══════════════════════════════════════════════════════════════════════

# ── Registry checks (defense-in-depth): required_states, deny_isolation, deny_background, artifacts ──
export _PAYLOAD="$PAYLOAD"
export _AGENT_TYPE="$SUBAGENT_TYPE"
GATE_RESULT=$(python3 "$(dirname "$0")/../scripts/agent-gate-check.py" 2>/dev/null || echo "$ACTIVE_SKILL	")
unset _PAYLOAD _AGENT_TYPE

# Parse tab-separated output: skill\twarn on line 1, errors on lines 2+
GATE_WARN=$(echo "$GATE_RESULT" | head -1 | cut -f2)
if [[ -n "$GATE_WARN" ]]; then
  echo "WARN: skill-agent-gate: $GATE_WARN" >&2
fi

# Accumulate registry errors
while IFS= read -r line; do
  [[ -n "$line" ]] && ERRORS+=("$line")
done < <(echo "$GATE_RESULT" | tail -n +2)

# ── Manifest declarative checks: requires_archetype, requires_traces, scope_condition ──
# REF: Archetype branching — see .claude/patterns/archetype-behavior-check.md Quick-Reference Table.
# All values passed via environment variables to avoid shell injection in Python literals.
export _SAG_MANIFEST="$MANIFEST" _SAG_AGENT="$SUBAGENT_TYPE"
export _SAG_PROJECT="$PROJECT_DIR" _SAG_TRACES="$TRACES_DIR"
export _SAG_SKILL="$ACTIVE_SKILL"
DECL_ERRORS=$(python3 -c "
import json, os

manifest = json.load(open(os.environ['_SAG_MANIFEST']))
agent_type = os.environ['_SAG_AGENT']
agent = manifest.get('agents', {}).get(agent_type, {})
project = os.environ['_SAG_PROJECT']
traces_dir = os.environ['_SAG_TRACES']
skill = os.environ['_SAG_SKILL']
errors = []

# --- requires_archetype ---
req_arch = agent.get('requires_archetype', '')
if req_arch:
    actual_arch = 'web-app'
    for ctx_name in ['verify-context.json', f'{skill}-context.json']:
        ctx_path = os.path.join(project, '.runs', ctx_name)
        if os.path.isfile(ctx_path):
            try:
                actual_arch = json.load(open(ctx_path)).get('archetype', 'web-app')
            except: pass
            break
    if actual_arch != req_arch:
        errors.append(f'{agent_type} requires archetype={req_arch} but got archetype={actual_arch}')

# --- requires_traces ---
def check_traces(trace_names, context_label=''):
    suffix = f' ({context_label})' if context_label else ''
    for tn in trace_names:
        tf = os.path.join(traces_dir, f'{tn}.json')
        if not os.path.isfile(tf):
            errors.append(f'{tn}.json trace missing — prerequisite agent has not completed{suffix}')
            continue
        try:
            td = json.load(open(tf))
        except:
            errors.append(f'{tn}.json could not be parsed{suffix}')
            continue
        if 'verdict' not in td:
            errors.append(f'{tn}.json missing verdict — agent may still be running{suffix}')
        # run_id freshness check
        run_id = td.get('run_id', '')
        vctx_path = os.path.join(project, '.runs', 'verify-context.json')
        if os.path.isfile(vctx_path) and run_id:
            try:
                expected = json.load(open(vctx_path)).get('run_id', '')
                if expected and run_id != expected:
                    errors.append(f'{tn}.json has stale run_id={run_id}, expected {expected}{suffix}')
            except: pass

check_traces(agent.get('requires_traces', []))

# --- scope_condition ---
sc = agent.get('scope_condition', {})
if sc:
    scope_val = sc.get('scope', '')
    actual_scope = ''
    for ctx_name in ['verify-context.json', f'{skill}-context.json']:
        ctx_path = os.path.join(project, '.runs', ctx_name)
        if os.path.isfile(ctx_path):
            try:
                actual_scope = json.load(open(ctx_path)).get('scope', '')
            except: pass
            break
    if actual_scope == scope_val:
        check_traces(sc.get('requires_traces', []), f'scope={scope_val}')

for e in errors:
    print(e)
" 2>/dev/null || echo "")
unset _SAG_MANIFEST _SAG_AGENT _SAG_PROJECT _SAG_TRACES _SAG_SKILL

while IFS= read -r line; do
  [[ -n "$line" ]] && ERRORS+=("$line")
done <<< "$DECL_ERRORS"

# ── Convention gate: .claude/skills/<skill>/gates/<subagent>.sh ──
GATE_SCRIPT="$PROJECT_DIR/.claude/skills/$ACTIVE_SKILL/gates/$SUBAGENT_TYPE.sh"

if [[ -f "$GATE_SCRIPT" ]]; then
  export PAYLOAD SUBAGENT_TYPE PROJECT_DIR TRACES_DIR
  GATE_OUTPUT=$(bash "$GATE_SCRIPT" 2>&1) || {
    [[ -n "$GATE_OUTPUT" ]] && ERRORS+=("$GATE_OUTPUT")
  }
fi

# ── Cross-skill agent checks ──
if [[ "$SUBAGENT_TYPE" == "pattern-classifier" ]]; then
  if [[ ! -f "$PROJECT_DIR/.runs/fix-log.md" ]]; then
    ERRORS+=("fix-log.md missing — required for pattern-classifier")
  fi
fi

# ── Universal checks ──
check_efficiency_directives

# ── Deny or allow ──
if [[ ${#ERRORS[@]} -gt 0 ]]; then
  deny_errors "State gate blocked: " "Complete prerequisite states before spawning $SUBAGENT_TYPE."
fi

exit 0
