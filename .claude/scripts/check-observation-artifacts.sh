#!/usr/bin/env bash
# check-observation-artifacts.sh — Deterministic post-observation artifact enforcement.
# Called from finalize-epilogue.md Step 2a after observation-phase.md returns.
# Validates that Steps 5a/5b/5c produced their expected artifacts based on scope.
#
# Non-blocking: always exits 0. Warnings go to stderr.
# Writes .runs/observation-enforcement.json for audit trail.
#
# Scope-to-artifact matrix:
#   full/process + agent traces: compliance-audit-result.json, retrospective-result.json, observe-result.json
#   full/process, no traces:     compliance-audit-result.json, observe-result.json
#   code/audit-only:             compliance-audit-result.json, observe-result.json
#
# Mirrors scope derivation from skill-epilogue.md lines 70-99.
set -uo pipefail
# NOTE: set -e is intentionally omitted. This script must ALWAYS write its
# audit artifact and exit 0. Using -e risks early exit before the artifact
# is written, violating the post-finalize non-blocking contract.

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"
RUNS_DIR="$PROJECT_DIR/.runs"

# Guarantee: always write a fallback audit artifact on unexpected exit
_write_fallback_artifact() {
  if [[ ! -f "$RUNS_DIR/observation-enforcement.json" ]]; then
    python3 -c "
import json, datetime
json.dump({
    'pass': False, 'missing': ['script-error'],
    'scope': '${SCOPE:-unknown}', 'skill': '${SKILL:-unknown}',
    'fast_path': False, 'error': 'script exited unexpectedly',
    'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open('$RUNS_DIR/observation-enforcement.json', 'w'), indent=2)
" 2>/dev/null || true
  fi
}
trap _write_fallback_artifact EXIT

# ── Derive skill name ──
SKILL=$(python3 -c "
import json, glob
files = [f for f in glob.glob('$RUNS_DIR/*-context.json')
         if 'epilogue' not in f and 'verify' not in f]
if files:
    print(json.load(open(files[0])).get('skill', 'unknown'))
else:
    print('unknown')
" 2>/dev/null || echo "unknown")

# ── Early exit: optimize-prompt (no observation) ──
if [[ "$SKILL" == "optimize-prompt" ]]; then
  python3 -c "
import json, datetime
json.dump({
    'pass': True, 'missing': [], 'scope': 'n/a', 'skill': 'optimize-prompt',
    'fast_path': False, 'skipped': True,
    'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open('$RUNS_DIR/observation-enforcement.json', 'w'), indent=2)
" 2>/dev/null || true
  exit 0
fi

# ── Derive scope (mirrors skill-epilogue.md lines 70-99) ──
SCOPE=$(python3 -c "
import os, glob

skill = '$SKILL'
skill_yaml_path = '$PROJECT_DIR/.claude/skills/' + skill + '/skill.yaml'

# Parse skill.yaml — try yaml, fallback to regex
has_embed_verify = False
has_critic = False
try:
    import yaml
    data = yaml.safe_load(open(skill_yaml_path))
    embed = data.get('embed', {})
    if isinstance(embed, dict) and embed.get('skill') == 'verify':
        has_embed_verify = True
    agents = data.get('agents', {})
    CRITIC_AGENTS = {'solve-critic', 'resolve-challenger', 'review-challenger'}
    if isinstance(agents, dict):
        has_critic = bool(CRITIC_AGENTS & set(agents.keys()))
except ImportError:
    # Fallback: regex-based parsing
    import re
    try:
        content = open(skill_yaml_path).read()
        if re.search(r'embed:.*\n\s+skill:\s*verify', content):
            has_embed_verify = True
        for agent in ['solve-critic', 'resolve-challenger', 'review-challenger']:
            if agent in content:
                has_critic = True
                break
    except FileNotFoundError:
        pass
except FileNotFoundError:
    pass

diffs_path = '$RUNS_DIR/observer-diffs.txt'
diffs_exist = os.path.exists(diffs_path) and os.path.getsize(diffs_path) > 0

if has_embed_verify:
    print('full')
elif has_critic and diffs_exist:
    print('full')
elif has_critic:
    print('process')
elif diffs_exist:
    print('code')
else:
    print('audit-only')
" 2>/dev/null || echo "unknown")

# ── Fast-path detection ──
# observation-phase.md Step 3 exits early when: no diffs, no fix-log entries,
# no agent trace fixes. In that case, only observe-result.json is written
# (verdict "clean") and Steps 4-7 are skipped — no 5a/5b artifacts expected.
FAST_PATH=$(python3 -c "
import json, os, glob

observe_path = '$RUNS_DIR/observe-result.json'
diffs_path = '$RUNS_DIR/observer-diffs.txt'
fixlog_path = '$RUNS_DIR/fix-log.md'

# Must have observe-result.json with verdict 'clean'
if not os.path.exists(observe_path):
    print('false')
    raise SystemExit
verdict = json.load(open(observe_path)).get('verdict', '')
if verdict != 'clean':
    print('false')
    raise SystemExit

# Diffs must be empty or missing
if os.path.exists(diffs_path) and os.path.getsize(diffs_path) > 0:
    print('false')
    raise SystemExit

# Fix-log must have no entries (skip header lines starting with # or empty)
if os.path.exists(fixlog_path):
    with open(fixlog_path) as f:
        entries = [l for l in f if l.strip() and not l.strip().startswith('#')]
    if entries:
        print('false')
        raise SystemExit

# Agent traces must have no fixes
for tf in glob.glob('$RUNS_DIR/agent-traces/*.json'):
    try:
        td = json.load(open(tf))
        fixes = td.get('fixes', td.get('fixes_evaluated', []))
        if isinstance(fixes, list) and len(fixes) > 0:
            print('false')
            raise SystemExit
        if isinstance(fixes, int) and fixes > 0:
            print('false')
            raise SystemExit
    except: pass

print('true')
" 2>/dev/null || echo "false")

# ── Artifact checks ──
MISSING=()
PASS="true"

if [[ "$FAST_PATH" == "true" ]]; then
  # Fast-path: only observe-result.json is expected (already confirmed to exist)
  :
else
  # observe-result.json — always required (Step 7)
  if [[ ! -f "$RUNS_DIR/observe-result.json" ]]; then
    MISSING+=("observe-result.json")
    echo "WARN: observation-enforcement: missing observe-result.json — observation may not have run" >&2
  fi

  # compliance-audit-result.json — always required (Step 5b always runs)
  if [[ ! -f "$RUNS_DIR/compliance-audit-result.json" ]]; then
    MISSING+=("compliance-audit-result.json")
    echo "WARN: observation-enforcement: missing compliance-audit-result.json — Step 5b may have been skipped" >&2
  fi

  # retrospective-result.json — required for full/process scope when agent traces exist (Step 5a)
  if [[ "$SCOPE" == "full" || "$SCOPE" == "process" ]]; then
    TRACES_EXIST=$(find "$RUNS_DIR/agent-traces" -maxdepth 1 -name '*.json' 2>/dev/null | head -1 || true)
    if [[ -n "$TRACES_EXIST" ]] && [[ ! -f "$RUNS_DIR/retrospective-result.json" ]]; then
      MISSING+=("retrospective-result.json")
      echo "WARN: observation-enforcement: missing retrospective-result.json — Step 5a may have been skipped (scope=$SCOPE, agent traces exist)" >&2
    fi
  fi
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  PASS="false"
fi

# ── Write audit artifact ──
# Build missing list as newline-delimited string, then convert in Python
MISSING_STR=""
for m in "${MISSING[@]+"${MISSING[@]}"}"; do
  MISSING_STR="${MISSING_STR}${m}"$'\n'
done

python3 <<PYEOF
import json, datetime

missing_raw = """${MISSING_STR}""".strip()
missing = [m for m in missing_raw.split('\n') if m] if missing_raw else []

json.dump({
    "pass": len(missing) == 0,
    "missing": missing,
    "scope": "${SCOPE}",
    "skill": "${SKILL}",
    "fast_path": "${FAST_PATH}" == "true",
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open("${RUNS_DIR}/observation-enforcement.json", "w"), indent=2)
PYEOF

exit 0
