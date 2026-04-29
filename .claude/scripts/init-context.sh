#!/usr/bin/env bash
# init-context.sh — Creates a skill's context file with base schema + optional extra fields.
# Usage: bash .claude/scripts/init-context.sh <skill> [extra_json]
# Examples:
#   bash .claude/scripts/init-context.sh solve
#   bash .claude/scripts/init-context.sh change '{"preliminary_type":null,"affected_areas":null,"solve_depth":null}'
#   bash .claude/scripts/init-context.sh iterate-cross @.runs/_iterate-cross-extra.json
# Companion to advance-state.sh which updates completed_states after each state passes.
set -euo pipefail

SKILL="${1:-}"
EXTRA="${2:-}"

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

# File-reference: @path reads extra JSON from file (resolve relative to PROJECT_DIR)
if [[ -n "$EXTRA" && "$EXTRA" == @* ]]; then
  EXTRA_FILE="${EXTRA#@}"
  [[ "$EXTRA_FILE" != /* ]] && EXTRA_FILE="$PROJECT_DIR/$EXTRA_FILE"
  if [[ ! -f "$EXTRA_FILE" ]]; then
    echo "ERROR: init-context.sh — extra file not found: $EXTRA_FILE" >&2
    exit 1
  fi
  EXTRA=$(cat "$EXTRA_FILE")
fi
CTX="$PROJECT_DIR/.runs/${SKILL}-context.json"

# --- Arg validation ---
if [[ -z "$SKILL" ]]; then
  echo "ERROR: init-context.sh — skill name required" >&2
  echo "Usage: bash .claude/scripts/init-context.sh <skill> [extra_json]" >&2
  exit 1
fi

# --- State-reset guard + identity check ---
# Status values:
#   completed    — prior run of THIS skill finished (completed=True). Re-invocation is
#                  a new run — reset to fresh context (issue #1006 FINALIZE-pin fix).
#   has_identity — in-flight run (run_id set, completed=False). Preserve.
#   block        — corrupt (no run_id but multiple completed_states). Exit.
#   no_identity  — stub / first run. Fall through to create.
if [[ -f "$CTX" ]]; then
  GUARD=$(python3 -c "
import json
d = json.load(open('$CTX'))
has_rid = bool(d.get('run_id', ''))
is_completed = d.get('completed', False) is True
if has_rid and is_completed:
    print('completed')
elif has_rid:
    print('has_identity')
else:
    cs = d.get('completed_states', [])
    print('block' if len(cs) > 1 else 'no_identity')
" 2>/dev/null || echo "no_identity")
  if [[ "$GUARD" == "block" ]]; then
    echo "ERROR: init-context.sh — $CTX exists with multiple completed states but no run_id (corrupt state). Delete it manually to re-initialize." >&2
    exit 1
  fi
  if [[ "$GUARD" == "completed" ]]; then
    # Prior run of this skill completed — re-invocation is a fresh run.
    # Emit a visible notice so the user knows prior state was cleared, then
    # fall through to write a new canonical context (overwriting $CTX).
    echo "INFO: init-context.sh — prior $SKILL run completed; resetting $CTX for fresh re-run." >&2
  elif [[ "$GUARD" == "has_identity" ]]; then
    if [[ -z "$EXTRA" || "$EXTRA" == "{}" ]]; then
      # Already initialized, nothing to merge — skip
      echo "INFO: init-context.sh — $CTX already has run_id, skipping" >&2
      exit 0
    else
      # Merge extra fields into existing context, protecting base infrastructure fields.
      # skill is protected: callers must not override identity (the #941 bug source).
      # Q-score attribution uses the separate attributed_to field.
      printf '%s' "$EXTRA" | python3 -c "
import json, sys
ctx = json.load(open('$CTX'))
extra = json.loads(sys.stdin.read())
protected = {'branch', 'timestamp', 'run_id', 'skill'}
dropped = []
for k, v in extra.items():
    if k in protected:
        dropped.append(k)
        continue
    ctx[k] = v
if dropped:
    sys.stderr.write('WARN: init-context.sh — ignored protected fields from extra: ' + ','.join(dropped) + ' (skill/branch/timestamp/run_id are immutable per #941; use attributed_to for Q-score attribution)\n')
json.dump(ctx, open('$CTX', 'w'))
"
      exit 0
    fi
  fi
  # completed or no_identity — fall through to create (overwrite stub/prior with canonical context)
fi

# --- Ensure .runs/ exists ---
mkdir -p "$PROJECT_DIR/.runs"

# --- Generate timestamp (shared for both timestamp and run_id) ---
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BRANCH="$(git branch --show-current)"

# --- Write context file ---
# Base schema includes identity fields (issue #941 fix):
#   skill           — physical running skill (never overridden by extra)
#   run_id          — $SKILL-$TS, authoritative id
#   parent          — {skill, run_id} of immediate parent, null when top-level
#   ancestors       — [{skill, run_id}, ...] root→parent chain, empty when top-level
#   attributed_to   — Q-score attribution, defaults to skill (see context-init.md)
#   completed       — false at init; set true by lifecycle-next.sh on EMBED_COMPLETE
#                     or by lifecycle-finalize.sh when the run ends
#
# Parent/ancestors are derived by lifecycle-init.sh --embed by reading the
# parent's context file directly (never trust a CLI-arg chain — R2 C8).
if [[ -z "$EXTRA" || "$EXTRA" == "{}" ]]; then
  # Pure bash — no python3 needed
  cat > "$CTX" << CTXEOF
{"skill":"$SKILL","branch":"$BRANCH","timestamp":"$TS","run_id":"$SKILL-$TS","completed_states":[],"parent":null,"ancestors":[],"attributed_to":"$SKILL","completed":false}
CTXEOF
else
  # Merge base + extra via python3. skill/branch/timestamp/run_id are protected
  # (issue #941: callers must not override identity via extra_json).
  printf '%s' "$EXTRA" | python3 -c "
import json, sys
base = {
    'skill': '$SKILL',
    'branch': '$BRANCH',
    'timestamp': '$TS',
    'run_id': '$SKILL-$TS',
    'completed_states': [],
    'parent': None,
    'ancestors': [],
    'attributed_to': '$SKILL',
    'completed': False,
}
extra = json.loads(sys.stdin.read())
protected = {'branch', 'timestamp', 'run_id', 'skill'}
dropped = []
for k, v in extra.items():
    if k in protected:
        dropped.append(k)
        continue
    base[k] = v
if dropped:
    sys.stderr.write('WARN: init-context.sh — ignored protected fields from extra: ' + ','.join(dropped) + ' (skill/branch/timestamp/run_id are immutable per #941; use attributed_to for Q-score attribution)\n')
json.dump(base, open('$CTX', 'w'))
"
fi
