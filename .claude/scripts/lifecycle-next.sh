#!/usr/bin/env bash
# lifecycle-next.sh — Phase 2: Dispatch to next state file.
# Usage: bash .claude/scripts/lifecycle-next.sh <skill>
# Output (stdout, one line):
#   /path/to/state-file.md   — next state to execute
#   FINALIZE                 — all states complete
#   NO_MANIFEST              — no manifest file found
#   NO_CONTEXT               — no context file found
set -euo pipefail

SKILL="${1:-}"

if [[ -z "$SKILL" ]]; then
  echo "ERROR: lifecycle-next.sh — skill name required" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

MANIFEST="$PROJECT_DIR/.runs/${SKILL}-manifest.json"

# --- Check prerequisites ---
if [[ ! -f "$MANIFEST" ]]; then
  echo "NO_MANIFEST"
  exit 0
fi

# Determine context file — mode-aware for iterate --check/--cross
if [[ "$SKILL" == "verify" ]]; then
  CTX="$PROJECT_DIR/.runs/verify-context.json"
else
  CTX_SKILL=$(python3 -c "
import json
m=json.load(open('$MANIFEST'))
am=m.get('active_mode','')
sk='$SKILL'
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$SKILL")
  CTX="$PROJECT_DIR/.runs/${CTX_SKILL}-context.json"
fi

if [[ ! -f "$CTX" ]]; then
  echo "NO_CONTEXT"
  exit 0
fi

# --- Dispatch logic (Python for JSON + glob) ---
PROJECT_DIR_ENV="$PROJECT_DIR" python3 - "$SKILL" "$CTX" "$MANIFEST" << 'PYEOF'
import json, sys, os, glob

skill = sys.argv[1]
ctx_path = sys.argv[2]
manifest_path = sys.argv[3]
project_dir = os.environ.get("PROJECT_DIR_ENV", ".")

# Directory mapping for state file lookup (v1 compat)
SKILL_DIR_MAP = {
    "iterate-check": "iterate",
    "iterate-cross": "iterate",
    "observe": "observe-cmd",
}

ctx = json.load(open(ctx_path))
manifest = json.load(open(manifest_path))

# completed_states as string set for consistent comparison
completed = set(str(s) for s in ctx.get("completed_states", []))

# Determine active states list
if "active_mode" in manifest and "modes" in manifest:
    mode = manifest["active_mode"]
    states = manifest["modes"][mode]["states"]
else:
    states = manifest.get("states", [])

if not states:
    print("NO_STATES")
    sys.exit(0)

loop_set = set(str(s) for s in manifest.get("loop", []))


def find_state_file(sk, state_id):
    """Find state file: v2 path first, then v1 compat path."""
    directory = SKILL_DIR_MAP.get(sk, sk)

    # v2: .claude/skills/<skill>/state-<id>-*.md
    v2_pattern = os.path.join(project_dir, ".claude", "skills", sk,
                              "state-%s-*.md" % state_id)
    v2_matches = sorted(glob.glob(v2_pattern))
    if v2_matches:
        return v2_matches[0]

    # v1: .claude/patterns/<directory>/state-<id>-*.md
    v1_pattern = os.path.join(project_dir, ".claude", "patterns", directory,
                              "state-%s-*.md" % state_id)
    v1_matches = sorted(glob.glob(v1_pattern))
    if v1_matches:
        return v1_matches[0]

    return None


# --- Loop handling ---
# If all loop states are completed, check loop-decision artifact.
# If continue: true → return first loop state, delete decision file.
# If continue: false or missing → skip loop states.
loop_continue = False
if loop_set and loop_set.issubset(completed):
    decision_file = os.path.join(project_dir, ".runs",
                                 "%s-loop-decision.json" % skill)
    if os.path.isfile(decision_file):
        try:
            decision = json.load(open(decision_file))
            if decision.get("continue") is True:
                loop_continue = True
                os.remove(decision_file)
        except (json.JSONDecodeError, OSError):
            pass

# If loop continues, remove loop states from completed so they're re-dispatched
if loop_continue:
    completed = completed - loop_set

# --- Find next state ---
for state_id in states:
    sid = str(state_id)
    if sid not in completed:
        path = find_state_file(skill, sid)
        if path:
            print(path)
        else:
            print("STATE_FILE_NOT_FOUND:%s:%s" % (skill, sid))
        sys.exit(0)

# All states completed
print("FINALIZE")
PYEOF
