#!/usr/bin/env bash
# update-context-branch.sh — Propagate the current branch to active *-context.json files.
# Called from .claude/patterns/branch.md Step 5 after `git checkout -b` succeeds.
#
# Usage:  bash .claude/scripts/update-context-branch.sh <OLD_BRANCH>
#
# Updates the `branch` field of every non-completed `.runs/*-context.json` whose
# current `branch` field equals `OLD_BRANCH` (and skips epilogue contexts).
# Scoping by old_branch prevents ancestor / unrelated parallel-run crossover —
# only contexts that were on the pre-checkout branch are migrated.
#
# Without this propagation, `resolve_active_identity` (in `.claude/hooks/lib-state.sh`)
# filters out the active context because its `branch` field is stale (captured by
# `init-context.sh` before `git checkout -b` ran). This silently breaks identity
# grounding for every downstream trace writer (`write-agent-trace.sh`,
# `write-degraded-trace.py`, `check-observation-artifacts.sh`).
#
# Atomicity: each context is written via a `.tmp` sibling + rename — partial
# writes from SIGINT/SIGKILL cannot leave a context file empty.
#
# Audit trail: every update appends one JSONL row to `.runs/branch-update-log.jsonl`
# with old_branch, new_branch, ctx_path, run_id, timestamp.
set -euo pipefail

OLD_BRANCH="${1:-}"

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"
NEW_BRANCH="$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "")"

if [[ -z "$NEW_BRANCH" ]]; then
  echo "WARN: update-context-branch.sh — could not determine current branch (detached HEAD?)" >&2
  exit 0
fi

if [[ -z "$OLD_BRANCH" ]]; then
  echo "WARN: update-context-branch.sh — OLD_BRANCH argument is required (capture via 'git branch --show-current' BEFORE checkout)" >&2
  exit 0
fi

if [[ "$OLD_BRANCH" == "$NEW_BRANCH" ]]; then
  # No-op when called without a real branch transition (idempotent).
  exit 0
fi

# nullglob so `.runs/*-context.json` does not loop literally on the pattern
# when no matching files exist (fresh checkout, pre-init scenarios).
shopt -s nullglob
CTX_FILES=("$PROJECT_DIR"/.runs/*-context.json)
shopt -u nullglob

if [[ ${#CTX_FILES[@]} -eq 0 ]]; then
  exit 0
fi

LOG="$PROJECT_DIR/.runs/branch-update-log.jsonl"
mkdir -p "$(dirname "$LOG")"

OLD_BRANCH_ENV="$OLD_BRANCH" \
NEW_BRANCH_ENV="$NEW_BRANCH" \
LOG_ENV="$LOG" \
python3 - "${CTX_FILES[@]}" << 'PYEOF'
import json, os, sys, datetime, tempfile

old_branch = os.environ['OLD_BRANCH_ENV']
new_branch = os.environ['NEW_BRANCH_ENV']
log_path = os.environ['LOG_ENV']
ctx_paths = sys.argv[1:]

now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
updated = 0

for ctx_path in ctx_paths:
    if not os.path.isfile(ctx_path):
        continue
    # Skip epilogue contexts — they are managed separately by skill-epilogue.md.
    if ctx_path.endswith('epilogue-context.json'):
        continue
    try:
        d = json.load(open(ctx_path))
    except Exception:
        continue
    # Skip completed contexts (preserve historical record intact).
    if d.get('completed') is True:
        continue
    # Scope: only update contexts that were on the pre-checkout branch.
    # Prevents ancestor / unrelated parallel-run crossover.
    if d.get('branch') != old_branch:
        continue

    d['branch'] = new_branch

    # Atomic write: tmp + rename so SIGINT mid-write cannot leave the file empty.
    tmp_fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(ctx_path) + '.',
        suffix='.tmp',
        dir=os.path.dirname(ctx_path),
    )
    try:
        with os.fdopen(tmp_fd, 'w') as f:
            json.dump(d, f, indent=2)
            f.write('\n')
        os.replace(tmp_path, ctx_path)
    except Exception:
        try: os.unlink(tmp_path)
        except OSError: pass
        continue

    # Audit-trail entry per update.
    entry = {
        'old_branch': old_branch,
        'new_branch': new_branch,
        'ctx_path': os.path.relpath(ctx_path, os.environ.get('PWD', '.')),
        'run_id': d.get('run_id', ''),
        'skill': d.get('skill', ''),
        'timestamp': now,
    }
    with open(log_path, 'a') as f:
        f.write(json.dumps(entry) + '\n')
    updated += 1

if updated:
    sys.stderr.write(
        f"INFO: update-context-branch.sh — propagated '{old_branch}' -> '{new_branch}' across {updated} context(s)\n"
    )
PYEOF

exit 0
