#!/usr/bin/env bash
# lifecycle-finalize.sh — Phase 3: Delivery gate + git ops.
# Usage: bash .claude/scripts/lifecycle-finalize.sh <skill>
# Output: FINALIZE_COMPLETE (on success)
#
# For code-writing skills (branch + diff):
#   1. Rerun ALL state VERIFY commands from state-registry.json
#   2. Validate verify-report.md frontmatter (if exists)
#   3. Scan gate-verdicts/*.json for BLOCK verdicts
#   4. Check observe-result.json exists
#   5. If all pass: commit → push → gh pr create → auto-merge
#
# For analysis skills (no branch or no diff):
#   Verify observe-result.json exists (warn if missing)
set -euo pipefail

SKILL="${1:-}"

if [[ -z "$SKILL" ]]; then
  echo "ERROR: lifecycle-finalize.sh — skill name required" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

# Determine context file
if [[ "$SKILL" == "verify" ]]; then
  CTX="$PROJECT_DIR/.runs/verify-context.json"
else
  CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"
fi

MANIFEST="$PROJECT_DIR/.runs/${SKILL}-manifest.json"

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

# --- Code-writing path: Delivery Gate ---
if [[ -n "$HAS_BRANCH" && -n "$HAS_DIFF" ]]; then
  GATE_RESULT=$(PROJECT_DIR_ENV="$PROJECT_DIR" python3 - "$SKILL" << 'PYEOF'
import json, os, subprocess, glob, sys

skill = sys.argv[1]
project_dir = os.environ.get("PROJECT_DIR_ENV", ".")
errors = []

# --- Gate 1: Rerun ALL state VERIFY commands ---
registry_path = os.path.join(project_dir, ".claude/patterns/state-registry.json")
if os.path.isfile(registry_path):
    registry = json.load(open(registry_path))
    skill_states = registry.get(skill, {})
    for state_id, raw in skill_states.items():
        # Skip metadata keys
        if state_id.startswith("_"):
            continue
        # Extract verify command (handle string and dict entries)
        if isinstance(raw, str):
            cmd = raw
        elif isinstance(raw, dict):
            cmd = raw.get("verify", "")
        else:
            continue
        if not cmd or cmd.strip() == "true":
            continue
        try:
            result = subprocess.run(cmd, shell=True, capture_output=True,
                                    timeout=30, cwd=project_dir)
            if result.returncode != 0:
                stderr = result.stderr.decode().strip()[:200]
                errors.append("VERIFY %s.%s failed: %s" % (skill, state_id, stderr))
        except subprocess.TimeoutExpired:
            errors.append("VERIFY %s.%s timed out" % (skill, state_id))
        except Exception as e:
            errors.append("VERIFY %s.%s error: %s" % (skill, state_id, e))

# --- Gate 2: verify-report.md frontmatter ---
report_path = os.path.join(project_dir, ".runs/verify-report.md")
if os.path.isfile(report_path):
    content = open(report_path).read()
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            fm = parts[1]
            required = ["overall_verdict:", "hard_gate_failure:",
                        "process_violation:", "agents_expected:",
                        "agents_completed:"]
            missing = [f for f in required if f not in fm]
            if missing:
                errors.append("verify-report.md frontmatter missing: %s" % missing)
        else:
            errors.append("verify-report.md frontmatter malformed")

# --- Gate 3: gate-verdicts scan for BLOCK ---
verdicts_dir = os.path.join(project_dir, ".runs/gate-verdicts")
if os.path.isdir(verdicts_dir):
    for vf in glob.glob(os.path.join(verdicts_dir, "*.json")):
        try:
            v = json.load(open(vf))
            if v.get("verdict") == "BLOCK":
                errors.append("BLOCK verdict in %s" % os.path.basename(vf))
        except (json.JSONDecodeError, OSError):
            pass

# --- Gate 4: observe-result.json exists ---
observe_path = os.path.join(project_dir, ".runs/observe-result.json")
if not os.path.isfile(observe_path):
    errors.append("observe-result.json not found")

# Output
if errors:
    for e in errors:
        print("GATE FAIL: %s" % e, file=sys.stderr)
    print("FAIL")
else:
    print("PASS")
PYEOF
  )

  if [[ "$GATE_RESULT" == "FAIL" ]]; then
    echo "ERROR: lifecycle-finalize.sh — delivery gate failed (see errors above)" >&2
    exit 1
  fi

  # --- Git delivery ---
  git add -A
  git commit -m "$(cat <<EOF
$SKILL: automated delivery

Co-Authored-By: Claude Code <noreply@anthropic.com>
EOF
)"
  git push -u origin HEAD

  # Create PR
  gh pr create --title "$SKILL: automated delivery" \
    --body "Automated delivery from lifecycle-finalize.sh" 2>/dev/null || \
    echo "WARN: lifecycle-finalize.sh — gh pr create failed (PR may already exist)" >&2

  # Auto-merge with safety guards
  SKIP_MERGE=""
  # Guard: migration files
  if git diff --name-only origin/main...HEAD 2>/dev/null | grep -q '^supabase/migrations/'; then
    echo "WARN: lifecycle-finalize.sh — PR contains migrations, skipping auto-merge" >&2
    SKIP_MERGE="true"
  fi
  # Guard: secret scan (advisory)
  if [[ -z "$SKIP_MERGE" ]] && command -v gitleaks >/dev/null 2>&1; then
    if ! gitleaks detect --source . --no-banner --exit-code 1 2>/dev/null; then
      echo "WARN: lifecycle-finalize.sh — gitleaks detected potential secrets, skipping auto-merge" >&2
      SKIP_MERGE="true"
    fi
  fi
  if [[ -z "$SKIP_MERGE" ]]; then
    gh pr merge --squash --delete-branch 2>/dev/null || \
      echo "WARN: lifecycle-finalize.sh — auto-merge failed" >&2
  fi

else
  # --- Analysis-only path ---
  if [[ ! -f "$PROJECT_DIR/.runs/observe-result.json" ]]; then
    echo "WARN: lifecycle-finalize.sh — observe-result.json missing" >&2
  fi
fi

echo "FINALIZE_COMPLETE"
