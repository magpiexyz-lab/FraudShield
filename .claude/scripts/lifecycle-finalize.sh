#!/usr/bin/env bash
# lifecycle-finalize.sh — Phase 3: Post-execution audit, Q-score, epilogue.
# Usage: bash .claude/scripts/lifecycle-finalize.sh <skill>
# Output: FINALIZE_COMPLETE + EPILOGUE_STRATEGY=A|B
#
# Steps (unconditional — runs for all skills):
#   1. Verify all states completed (warn if missing)
#   2. Rerun ALL state VERIFY commands from state-registry.json (warn on failure)
#   3. Q-score: read .runs/q-dimensions.json → call write-q-score.py (skip if absent)
#   4. Epilogue strategy: output EPILOGUE_STRATEGY=A (diffs vs main) or B (no diffs)
#
# Delivery (commit/push/PR/merge) is NOT handled here — see PR 2.
set -euo pipefail

SKILL="${1:-}"

if [[ -z "$SKILL" ]]; then
  echo "ERROR: lifecycle-finalize.sh — skill name required" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

MANIFEST="$PROJECT_DIR/.runs/${SKILL}-manifest.json"

# Determine context file — mode-aware for iterate --check/--cross
if [[ "$SKILL" == "verify" ]]; then
  CTX="$PROJECT_DIR/.runs/verify-context.json"
elif [[ -f "$MANIFEST" ]]; then
  CTX_SKILL=$(python3 -c "
import json
m=json.load(open('$MANIFEST'))
am=m.get('active_mode','')
sk='$SKILL'
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$SKILL")
  CTX="$PROJECT_DIR/.runs/${CTX_SKILL}-context.json"
else
  CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"
fi

if [[ ! -f "$CTX" ]]; then
  echo "ERROR: lifecycle-finalize.sh — $CTX not found" >&2
  exit 1
fi

# --- Verify all states completed ---
python3 -c "
import json, sys
ctx = json.load(open('$CTX'))
completed = set(str(s) for s in ctx.get('completed_states', []))
manifest_path = '$MANIFEST'
try:
    manifest = json.load(open(manifest_path))
    if 'active_mode' in manifest and 'modes' in manifest:
        states = manifest['modes'][manifest['active_mode']]['states']
    else:
        states = manifest.get('states', [])
    missing = [str(s) for s in states if str(s) not in completed]
    if missing:
        print('WARN: lifecycle-finalize.sh — states not completed: %s' % missing, file=sys.stderr)
except FileNotFoundError:
    pass
"

# --- Determine skill type ---
HAS_BRANCH=""
if [[ -f "$MANIFEST" ]]; then
  HAS_BRANCH=$(python3 -c "import json; print(json.load(open('$MANIFEST')).get('branch',''))" 2>/dev/null || echo "")
fi

HAS_DIFF=""
if [[ -n "$HAS_BRANCH" ]]; then
  if ! git diff --quiet HEAD 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    HAS_DIFF="true"
  fi
fi

# --- Step 2: Rerun ALL state VERIFY commands (unconditional, warn-only) ---
# Determine registry key — mode-aware for iterate --check/--cross
REGISTRY_SKILL="$SKILL"
if [[ -f "$MANIFEST" ]]; then
  REGISTRY_SKILL=$(python3 -c "
import json
m=json.load(open('$MANIFEST'))
am=m.get('active_mode','')
sk='$SKILL'
# iterate-check, iterate-cross use hyphenated keys in registry
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$SKILL")
fi

python3 -c "
import json, subprocess, sys, os

skill = '$REGISTRY_SKILL'
project_dir = '$PROJECT_DIR'
registry_path = os.path.join(project_dir, '.claude/patterns/state-registry.json')

if not os.path.isfile(registry_path):
    print('WARN: state-registry.json not found, skipping VERIFY rerun', file=sys.stderr)
    sys.exit(0)

registry = json.load(open(registry_path))
skill_states = registry.get(skill, {})
failures = 0

for state_id, raw in skill_states.items():
    if state_id.startswith('_'):
        continue
    if isinstance(raw, str):
        cmd = raw
    elif isinstance(raw, dict):
        cmd = raw.get('verify', '')
    else:
        continue
    if not cmd or cmd.strip() == 'true':
        continue
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True,
                                timeout=30, cwd=project_dir)
        if result.returncode != 0:
            stderr = result.stderr.decode().strip()[:200]
            print('WARN: VERIFY %s.%s failed: %s' % (skill, state_id, stderr), file=sys.stderr)
            failures += 1
    except subprocess.TimeoutExpired:
        print('WARN: VERIFY %s.%s timed out' % (skill, state_id), file=sys.stderr)
        failures += 1
    except Exception as e:
        print('WARN: VERIFY %s.%s error: %s' % (skill, state_id, e), file=sys.stderr)
        failures += 1

if failures > 0:
    print('WARN: %d VERIFY command(s) failed (non-blocking)' % failures, file=sys.stderr)
"

# --- Step 3: Q-score — read q-dimensions.json, call write-q-score.py ---
Q_DIMS_PATH="$PROJECT_DIR/.runs/q-dimensions.json"
if [[ -f "$Q_DIMS_PATH" ]]; then
  python3 -c "
import json, subprocess, sys, os

dims_path = '$Q_DIMS_PATH'
project_dir = '$PROJECT_DIR'
script = os.path.join(project_dir, '.claude/scripts/write-q-score.py')

if not os.path.isfile(script):
    print('WARN: write-q-score.py not found, skipping Q-score', file=sys.stderr)
    sys.exit(0)

d = json.load(open(dims_path))
args = [
    'python3', script,
    '--skill', d.get('skill', '$SKILL'),
    '--scope', d.get('scope', 'N/A'),
    '--dims', json.dumps(d.get('dims', {})),
    '--run-id', d.get('run_id', ''),
]
try:
    result = subprocess.run(args, capture_output=True, timeout=30, cwd=project_dir)
    if result.stdout:
        print(result.stdout.decode().strip())
    if result.returncode != 0:
        print('WARN: write-q-score.py exited %d: %s' % (result.returncode, result.stderr.decode().strip()[:200]), file=sys.stderr)
except Exception as e:
    print('WARN: Q-score write failed: %s' % e, file=sys.stderr)
" || true
else
  echo "WARN: lifecycle-finalize.sh — .runs/q-dimensions.json not found, skipping Q-score" >&2
fi

# --- Step 4: Epilogue strategy determination ---
EPILOGUE_STRATEGY="B"
if [[ -n "$HAS_BRANCH" ]]; then
  # Check for committed diffs relative to main
  MERGE_BASE=$(git merge-base main HEAD 2>/dev/null || echo "")
  if [[ -n "$MERGE_BASE" ]] && ! git diff --quiet "$MERGE_BASE"...HEAD 2>/dev/null; then
    EPILOGUE_STRATEGY="A"
    # Collect evidence: diffs for observer
    git diff "$MERGE_BASE"...HEAD > "$PROJECT_DIR/.runs/observer-diffs.txt" 2>/dev/null || true
  fi
fi

# Collect fix-log availability
if [[ -f "$PROJECT_DIR/.runs/fix-log.md" ]] && [[ -s "$PROJECT_DIR/.runs/fix-log.md" ]]; then
  echo "INFO: fix-log.md present ($(wc -l < "$PROJECT_DIR/.runs/fix-log.md") lines)" >&2
fi

echo "EPILOGUE_STRATEGY=$EPILOGUE_STRATEGY"
echo "FINALIZE_COMPLETE"
