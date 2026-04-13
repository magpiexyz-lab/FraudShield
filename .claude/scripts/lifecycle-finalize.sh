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
# Steps (unconditional — runs for all skills):
#   5. Delivery: read .runs/ artifacts → gate checks → commit/push/PR/auto-merge
set -euo pipefail

SKILL="${1:-}"

if [[ -z "$SKILL" ]]; then
  echo "ERROR: lifecycle-finalize.sh — skill name required" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

MANIFEST="$PROJECT_DIR/.runs/${SKILL}-manifest.json"

# Determine context file — mode-aware for iterate --check/--cross
source "$(dirname "$0")/lifecycle-lib.sh"
CTX=$(resolve_context_path "$SKILL" "$MANIFEST")

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
REGISTRY_SKILL=$(resolve_registry_key "$SKILL" "$MANIFEST")

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

# --- Step 5: Delivery (code-writing skills only) ---
COMMIT_MSG="$PROJECT_DIR/.runs/commit-message.txt"
PR_TITLE="$PROJECT_DIR/.runs/pr-title.txt"
PR_BODY="$PROJECT_DIR/.runs/pr-body.md"
SKIP_FLAG="$PROJECT_DIR/.runs/delivery-skip.flag"

if [[ -f "$SKIP_FLAG" ]]; then
  echo "INFO: delivery-skip.flag present — skipping delivery" >&2
  echo "DELIVERY=skipped"
elif [[ -f "$COMMIT_MSG" ]]; then
  # --- Delivery gates ---
  GATE_ERRORS=()

  # Gate 1: verify-report.md frontmatter validation (if exists)
  REPORT="$PROJECT_DIR/.runs/verify-report.md"
  if [[ -f "$REPORT" ]]; then
    python3 -c "
import sys
c = open('$REPORT').read()
if not c.startswith('---'):
    print('verify-report.md missing frontmatter delimiters', file=sys.stderr); sys.exit(1)
parts = c.split('---', 2)
if len(parts) < 3:
    print('verify-report.md malformed frontmatter', file=sys.stderr); sys.exit(1)
fm = parts[1]
for field in ['overall_verdict:', 'agents_expected:', 'agents_completed:']:
    if field not in fm:
        print('verify-report.md missing %s' % field, file=sys.stderr); sys.exit(1)
" 2>&1 || GATE_ERRORS+=("verify-report.md frontmatter validation failed")
  fi

  # Gate 2: gate-verdicts scan for BLOCK
  if [[ -d "$PROJECT_DIR/.runs/gate-verdicts" ]]; then
    BLOCK_FOUND=$(python3 -c "
import json, glob
blocked = []
for f in glob.glob('$PROJECT_DIR/.runs/gate-verdicts/*.json'):
    try:
        d = json.load(open(f))
        if d.get('verdict') == 'BLOCK':
            blocked.append(f.split('/')[-1])
    except: pass
print(' '.join(blocked) if blocked else '')
" 2>/dev/null || echo "")
    if [[ -n "$BLOCK_FOUND" ]]; then
      GATE_ERRORS+=("BLOCK verdict found in: $BLOCK_FOUND")
    fi
  fi

  # Gate 3: observe-result.json validation (if exists)
  if [[ -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
    python3 -c "
import json, sys
d = json.load(open('$PROJECT_DIR/.runs/observe-result.json'))
if not d.get('verdict'):
    print('observe-result.json missing verdict', file=sys.stderr); sys.exit(1)
" 2>&1 || GATE_ERRORS+=("observe-result.json validation failed")
  fi

  # Gate 4: build-result.json (if exists and no verify-report)
  if [[ ! -f "$REPORT" && -f "$PROJECT_DIR/.runs/build-result.json" ]]; then
    python3 -c "
import json, sys
d = json.load(open('$PROJECT_DIR/.runs/build-result.json'))
if d.get('exit_code') != 0:
    print('build exit_code=%s' % d.get('exit_code'), file=sys.stderr); sys.exit(1)
" 2>&1 || GATE_ERRORS+=("build-result.json exit_code != 0")
  fi

  if [[ ${#GATE_ERRORS[@]} -gt 0 ]]; then
    echo "ERROR: Delivery gate failed:" >&2
    for e in "${GATE_ERRORS[@]}"; do
      echo "  - $e" >&2
    done
    exit 1
  fi

  # --- Git delivery ---
  git add -A -- ':!.runs/'
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "$(cat "$COMMIT_MSG")"
  fi
  git push -u origin HEAD

  # --- PR creation (only if pr-title.txt exists) ---
  if [[ -f "$PR_TITLE" ]]; then
    PR_TITLE_VAL=$(cat "$PR_TITLE")
    gh pr create --title "$PR_TITLE_VAL" --body-file "$PR_BODY"

    # --- Auto-merge (per .claude/patterns/auto-merge.md) ---
    SKIP_MERGE=""

    # Guard 1: Migration guard
    if gh pr diff --name-only 2>/dev/null | grep -q '^supabase/migrations/'; then
      echo "INFO: PR contains database migrations — skipping auto-merge" >&2
      SKIP_MERGE="migrations"
    fi

    # Guard 2: Secret scan (graceful)
    if [[ -z "$SKIP_MERGE" ]] && command -v gitleaks >/dev/null 2>&1; then
      if ! gitleaks detect --source . --no-banner --exit-code 1 2>/dev/null; then
        echo "INFO: gitleaks detected potential secrets — skipping auto-merge" >&2
        SKIP_MERGE="gitleaks"
      fi
    fi

    # Merge
    if [[ -z "$SKIP_MERGE" ]]; then
      FEATURE_BRANCH=$(git branch --show-current)
      if [[ -n "${CLAUDE_WORKTREE:-}" ]]; then
        gh pr merge --squash || {
          echo "WARN: gh pr merge failed — PR left open" >&2
          SKIP_MERGE="merge-failed"
        }
      else
        gh pr merge --squash --delete-branch || {
          echo "WARN: gh pr merge failed — PR left open" >&2
          SKIP_MERGE="merge-failed"
        }
      fi
    fi

    # Post-merge (FEATURE_BRANCH captured on line 300 before merge)
    if [[ -z "$SKIP_MERGE" && -z "${CLAUDE_WORKTREE:-}" ]]; then
      git checkout main && git pull
      git branch -d "$FEATURE_BRANCH" 2>/dev/null || true
    fi

    if [[ -z "$SKIP_MERGE" ]]; then
      echo "DELIVERY=merged"
    else
      echo "DELIVERY=pr-created:$SKIP_MERGE"
    fi
  else
    # commit+push only — no PR (bootstrap pattern)
    echo "DELIVERY=pushed"
  fi
else
  # No delivery artifacts — analysis skill
  echo "DELIVERY=none"
fi

echo "FINALIZE_COMPLETE"
