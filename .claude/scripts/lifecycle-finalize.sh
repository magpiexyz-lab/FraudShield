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
#   6. Write .runs/verify-recheck.json for remediation phase (mandatory execution, graceful degradation)
set -euo pipefail

SKILL="${1:-}"

if [[ -z "$SKILL" ]]; then
  echo "ERROR: lifecycle-finalize.sh — skill name required" >&2
  exit 1
fi

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"

# Source lifecycle-lib first so resolve_framework_manifest is available below.
source "$(dirname "$0")/lifecycle-lib.sh"
MANIFEST=$(resolve_framework_manifest "$SKILL")

# Determine context file — mode-aware for iterate --check/--cross
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
skip = set(str(s) for s in ctx.get('skip_states', []))
manifest_path = '$MANIFEST'
try:
    manifest = json.load(open(manifest_path))
    if 'active_mode' in manifest and 'modes' in manifest:
        states = manifest['modes'][manifest['active_mode']]['states']
    else:
        states = manifest.get('states', [])
    missing = [str(s) for s in states if str(s) not in completed and str(s) not in skip]
    # Exclude in-flight epilogue state 99: it is currently running this script, and
    # its VERIFY (state-completion-gate) is the real gate for advancing 99 — see
    # Step 2's same self-skip at L103-L113 and PR #1059 design intent. Without this
    # exclusion, the has_agents branch below hard-errors on every skill entering 99
    # for the first time (fix #1063).
    missing = [s for s in missing if str(s) != '99']
    if missing:
        has_agents = bool(manifest.get('agents', {}))
        if has_agents:
            print('ERROR: lifecycle-finalize.sh — states not completed: %s' % missing, file=sys.stderr)
            sys.exit(1)
        else:
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
verify_results = []

ctx_path = '$CTX'
skip = set()
if os.path.isfile(ctx_path):
    try:
        skip = set(str(s) for s in json.load(open(ctx_path)).get('skip_states', []))
    except: pass

for state_id, raw in skill_states.items():
    if state_id.startswith('_'):
        continue
    if state_id in skip:
        continue
    # State 99 (epilogue) is currently in flight — its VERIFY checks artifacts
    # that THIS script writes (verify-recheck.json at Step 6). Verifying it
    # here would fail self-referentially. State 99's own advance-state hook
    # is the real gate.
    if state_id == '99':
        continue
    if isinstance(raw, str):
        cmd = raw
        lifecycle = 'durable'
    elif isinstance(raw, dict):
        cmd = raw.get('verify', '')
        lifecycle = raw.get('lifecycle', 'durable')
    else:
        continue
    if not cmd or cmd.strip() == 'true':
        continue
    # Skip ONLY transient-intra-skill (closes #1162 part 1). At finalize-time
    # of skill X:
    #   - transient-intra-skill: deleter-state already ran → artifact missing →
    #     skip (reporting WARN trains users to ignore real warnings).
    #   - transient-cross-skill: deleter is lifecycle-init of NEXT skill →
    #     artifact still exists during current finalize → DO NOT skip; rerun
    #     VERIFY to catch real production failures.
    #   - durable: must exist → rerun VERIFY (existing warn-only behavior).
    if lifecycle == 'transient-intra-skill':
        verify_results.append({'state': state_id, 'passed': True, 'error': None,
                               'skipped': 'transient-intra-skill'})
        continue
    entry = {'state': state_id, 'passed': True, 'error': None}
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True,
                                timeout=30, cwd=project_dir)
        if result.returncode != 0:
            stderr = result.stderr.decode().strip()[:200]
            entry['passed'] = False
            entry['error'] = stderr
            print('WARN: VERIFY %s.%s failed: %s' % (skill, state_id, stderr), file=sys.stderr)
            failures += 1
        verify_results.append(entry)
    except subprocess.TimeoutExpired:
        entry['passed'] = False
        entry['error'] = 'timeout'
        verify_results.append(entry)
        print('WARN: VERIFY %s.%s timed out' % (skill, state_id), file=sys.stderr)
        failures += 1
    except Exception as e:
        entry['passed'] = False
        entry['error'] = str(e)[:200]
        verify_results.append(entry)
        print('WARN: VERIFY %s.%s error: %s' % (skill, state_id, e), file=sys.stderr)
        failures += 1

if failures > 0:
    print('WARN: %d VERIFY command(s) failed (non-blocking)' % failures, file=sys.stderr)

# Write raw verify results for remediation phase (Step 6 assembles final JSON)
try:
    raw_path = os.path.join(project_dir, '.runs/.verify-results-raw.json')
    json.dump(verify_results, open(raw_path, 'w'), indent=2)
except Exception as e:
    print('WARN: failed to write .verify-results-raw.json: %s' % e, file=sys.stderr)
"

# --- Step 2.5: AOC v1 FLS v1 — consolidate agent trace fixes[] into ledger ---
# Ensures every skill (not just /verify) ends with a fresh .runs/fix-ledger.jsonl
# for downstream consumers (pattern-classifier, observation-phase, write-q-score,
# verify-report-gate). Idempotent: safe to run unconditionally. Writes an empty
# ledger if no traces exist. The renderer is invoked by observation-phase's
# fallback when fix-log.md is empty; we do NOT regenerate fix-log.md here so
# that state-5 inline WARN entries and procedure-emitted `Fix (agent): ...`
# prose entries are preserved during the transitional dual-check period.
if [[ -d "$PROJECT_DIR/.runs/agent-traces" ]]; then
  python3 "$PROJECT_DIR/.claude/scripts/write-fix-ledger.py" >/dev/null 2>&1 || true
fi

# --- Step 2.6: Aggregate hook-friction.jsonl into hook-friction-summary.json (#1226) ---
# Canonical owner of aggregate-hook-friction.py invocation. Always runs when
# .runs/hook-friction.jsonl is non-empty so the Q2 4th evidence channel is
# always available to the lead retrospective (Step 5a in observation-phase.md).
# Idempotent: aggregator overwrites the summary file each run. Filtered by
# current run_id inside the aggregator. Replaces the previously-conditional
# call inside observation-phase.md Step 2d, which the lead could skip and
# silently produce a falsely-clean retrospective.
if [[ -s "$PROJECT_DIR/.runs/hook-friction.jsonl" ]]; then
  python3 "$PROJECT_DIR/.claude/scripts/aggregate-hook-friction.py" >/dev/null 2>&1 || true
fi

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
    # Scan template-owned paths for lead-applied edits not already in the
    # ledger (#1128 Layer 5). Gated on EPILOGUE_STRATEGY="A" — only runs when
    # there is a real branch with real commit-diff. On main or with no diff,
    # the scanner's HEAD~1...HEAD fallback would mis-attribute prior commits
    # (e.g., merged PRs) to the current skill. Idempotent + fail-open.
    if [[ -x "$PROJECT_DIR/.claude/scripts/scan-template-edits.sh" ]]; then
      bash "$PROJECT_DIR/.claude/scripts/scan-template-edits.sh" "$SKILL" 2>/dev/null || true
    fi
  fi
fi

# Collect fix-log availability
if [[ -f "$PROJECT_DIR/.runs/fix-log.md" ]] && [[ -s "$PROJECT_DIR/.runs/fix-log.md" ]]; then
  echo "INFO: fix-log.md present ($(wc -l < "$PROJECT_DIR/.runs/fix-log.md") lines)" >&2
fi

echo "EPILOGUE_STRATEGY=$EPILOGUE_STRATEGY"

# --- Step 4.5: Cross-file coherence lint (cached, gated, warn-only) ---
# Runs verify-linter.sh in --warn-only mode, writing findings to a cache file
# that observation-phase Step 5b-coherence reads. Gated on:
#   (a) cache miss (no prior run), OR
#   (b) template files (.claude/) changed on this branch since last run
# Cache key: git rev-parse HEAD:.claude/  (content-addressed, not mtime)
# Findings are folded into observe-result.json downstream — never blocks here.
COHERENCE_CACHE="$PROJECT_DIR/.runs/template-coherence-cache.json"
if [[ -z "${SKIP_COHERENCE_LINT:-}" ]]; then
  TEMPLATE_HASH=$(git rev-parse HEAD:.claude/ 2>/dev/null || echo "uncommitted")
  CACHED_HASH=""
  if [[ -f "$COHERENCE_CACHE" ]]; then
    CACHED_HASH=$(python3 -c "import json; print(json.load(open('$COHERENCE_CACHE')).get('template_hash',''))" 2>/dev/null || echo "")
  fi
  DIFF_TOUCHES_TEMPLATE="no"
  if [[ -n "$HAS_BRANCH" ]] && [[ -n "${MERGE_BASE:-}" ]]; then
    if git diff "$MERGE_BASE"...HEAD --name-only 2>/dev/null | grep -q '^\.claude/'; then
      DIFF_TOUCHES_TEMPLATE="yes"
    fi
  fi
  if [[ "$TEMPLATE_HASH" != "$CACHED_HASH" ]] || [[ "$DIFF_TOUCHES_TEMPLATE" == "yes" ]]; then
    # AOC v1: --strict-aoc escalates aoc-verdict-vocab-consistency /
    # aoc-fix-ledger-ownership / aoc-consumer-coverage findings to blocking
    # regardless of --warn-only. Other drift classes continue as warn-only
    # discovery. See .claude/patterns/agent-output-contract.md.
    LINTER_EXIT=0
    bash "$PROJECT_DIR/.claude/scripts/verify-linter.sh" --warn-only --strict-aoc --cache "$COHERENCE_CACHE" >/dev/null 2>&1 || LINTER_EXIT=$?
    # Annotate cache with the hash that produced it (so next run can compare)
    if [[ -f "$COHERENCE_CACHE" ]]; then
      python3 -c "
import json
d = json.load(open('$COHERENCE_CACHE'))
d['template_hash'] = '$TEMPLATE_HASH'
json.dump(d, open('$COHERENCE_CACHE', 'w'), indent=2)
" 2>/dev/null || true
    fi
    if [[ "$LINTER_EXIT" -ne 0 ]]; then
      echo "BLOCK: AOC v1 coherence violation (aoc-verdict-vocab-consistency / aoc-fix-ledger-ownership / aoc-consumer-coverage)." >&2
      bash "$PROJECT_DIR/.claude/scripts/verify-linter.sh" --strict-aoc 2>&1 | tail -40 >&2 || true
      echo "Re-run: bash .claude/scripts/verify-linter.sh --strict-aoc" >&2
      exit 1
    fi
  fi

  # Sibling lint (warn-only): scan init-context.sh callers for protected-field
  # drops (the dead-code symptom that produced #1160). Findings written to
  # .runs/init-context-caller-findings.jsonl; never blocks. Phase E2 of
  # canonical-writer-policy work.
  bash "$PROJECT_DIR/.claude/scripts/check-init-context-callers.sh" 2>/dev/null || true

  # Worktree-ownership pattern (issue #1200): blocking. Asserts that every
  # command file calling EnterWorktree also has the canonical IN_WORKTREE
  # detection block + worktree_owner ownership flag + conditional ExitWorktree;
  # and that no state file calls EnterWorktree (Rule 13 forbids it).
  if ! python3 "$PROJECT_DIR/.claude/scripts/check-worktree-ownership-pattern.py" >&2; then
    echo "BLOCK: worktree-ownership-pattern violation (issue #1200)." >&2
    echo "Re-run: python3 .claude/scripts/check-worktree-ownership-pattern.py" >&2
    exit 1
  fi

  # Worktree-boundary hook registration (issue #1225): blocking. Asserts that
  # worktree-boundary-gate.sh exists and is registered under Write, Edit,
  # MultiEdit, and NotebookEdit PreToolUse matchers in settings.json.
  if ! python3 "$PROJECT_DIR/.claude/scripts/check-worktree-boundary-hook-registered.py" >&2; then
    echo "BLOCK: worktree-boundary-hook-registered violation (issue #1225)." >&2
    echo "Re-run: python3 .claude/scripts/check-worktree-boundary-hook-registered.py" >&2
    exit 1
  fi

  # NOTE: Retrospective-completeness gate (#1276) was MOVED from this script
  # to .claude/scripts/check-observation-artifacts.sh. lifecycle-finalize.sh
  # runs in state-99 Step 1, BEFORE observation-phase Step 5a writes
  # retrospective-result.json (which happens in state-99 Step 2). Wiring the
  # gate here always SKIPped because the file doesn't exist yet. The gate
  # now lives at the correct point: check-observation-artifacts.sh, which
  # runs in state-99 Step 2a (after observation completes).
fi

# --- Step 4.6: RMG v2 typed-guard artifact existence + advisory recurrence detector ---
# Runs only when .runs/solve-trace.json exists AND prevention_analysis.problem_type
# == "defect". Two responsibilities:
#
#   1. Verify the typed recurrence_guard parses via
#      .claude/scripts/lib/recurrence_guard_parser.py (Phase A). When the guard's
#      kind is in {test, lint, hook, invariant}, assert its `artifact` path is
#      either present in the PR diff (git diff <merge_base>...HEAD --name-only)
#      or already on disk in the repo. When kind=none, assert
#      `unguardability_rationale` is present and non-trivial. Failure BLOCKS
#      delivery. This is the layer that turned recurrence_guard from a
#      documented intent into an enforced artifact.
#
#   2. Best-effort: invoke the recurrence-detector (Phase B) in advisory mode.
#      Wrapped in `set +e` — any non-zero exit logs a warning and is ignored
#      so a flaky detector cannot block delivery (per plan: detector is
#      additive, not load-bearing).
#
# This step exists at lifecycle-finalize time (post-build, pre-PR) rather than
# in adversarial-merge-gate.sh because the hook fires PreToolUse Write/Edit
# when the PR does not yet exist (`gh pr diff` is unavailable). Plan note R2-A7.
SOLVE_TRACE="$PROJECT_DIR/.runs/solve-trace.json"
if [[ -f "$SOLVE_TRACE" ]]; then
  IS_DEFECT=$(python3 -c "
import json
try:
    d = json.load(open('$SOLVE_TRACE'))
    pa = d.get('prevention_analysis') or {}
    print('1' if pa.get('problem_type') == 'defect' else '0')
except Exception:
    print('0')
" 2>/dev/null || echo "0")

  if [[ "$IS_DEFECT" == "1" ]]; then
    MERGE_BASE_REF="${MERGE_BASE:-}"
    if [[ -z "$MERGE_BASE_REF" ]]; then
      MERGE_BASE_REF=$(git -C "$PROJECT_DIR" merge-base origin/main HEAD 2>/dev/null || echo "main")
    fi
    if ! python3 "$PROJECT_DIR/.claude/scripts/verify-rmg-guard-artifact-in-diff.py" \
          --trace "$SOLVE_TRACE" \
          --merge-base "$MERGE_BASE_REF" >&2; then
      echo "BLOCK: RMG v2 typed-guard artifact check failed at lifecycle-finalize Step 4.6." >&2
      echo "Re-run: python3 .claude/scripts/verify-rmg-guard-artifact-in-diff.py --trace .runs/solve-trace.json --merge-base \$(git merge-base origin/main HEAD)" >&2
      exit 1
    fi
  fi
fi

# Advisory recurrence-detector: never blocks. Its output is consumed by Phase 1a
# dossier on the NEXT defect run; this run does not depend on the result.
set +e
PROJECT_DIR="$PROJECT_DIR" python3 "$PROJECT_DIR/.claude/scripts/recurrence-detector.py" \
  --advisory-only >/dev/null 2>&1
RECDET_RC=$?
set -e
if [[ $RECDET_RC -ne 0 ]]; then
  echo "WARN: recurrence-detector exited $RECDET_RC (advisory only — does not block)" >&2
fi

# --- Step 5: Delivery (code-writing skills only) ---
DELIVERY_STATUS="none"
COMMIT_MSG="$PROJECT_DIR/.runs/commit-message.txt"
PR_TITLE="$PROJECT_DIR/.runs/pr-title.txt"
PR_BODY="$PROJECT_DIR/.runs/pr-body.md"
SKIP_FLAG="$PROJECT_DIR/.runs/delivery-skip.flag"

# Skill-type gate — read `type:` from .claude/commands/<skill>.md frontmatter.
# Analysis-only skills MUST never ship code even if stale delivery artifacts are
# present (see observation #1004). Fail-closed: on read error, treat as unknown
# (proceed to existing gates) so a malformed frontmatter does not block
# legitimate code-writing skills.
SKILL_TYPE=""
SKILL_CMD_FILE="$PROJECT_DIR/.claude/commands/$SKILL.md"
if [[ -f "$SKILL_CMD_FILE" ]]; then
  SKILL_TYPE=$(python3 -c "
import sys, re
try:
    txt = open(sys.argv[1]).read()
    m = re.match(r'---\n(.*?)\n---', txt, re.DOTALL)
    if m:
        for line in m.group(1).splitlines():
            k, _, v = line.partition(':')
            if k.strip() == 'type':
                print(v.strip().strip('\"\\''))
                break
except Exception:
    pass
" "$SKILL_CMD_FILE" 2>/dev/null || echo "")
fi

if [[ "$SKILL_TYPE" == "analysis-only" ]]; then
  echo "INFO: $SKILL is analysis-only — skipping delivery (stale delivery artifacts ignored)" >&2
  DELIVERY_STATUS="skipped-analysis-only"
  echo "DELIVERY=skipped-analysis-only"
elif [[ -f "$SKIP_FLAG" ]]; then
  echo "INFO: delivery-skip.flag present — skipping delivery" >&2
  DELIVERY_STATUS="skipped"
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
for field in ['overall_verdict:', 'hard_gate_failure:', 'process_violation:', 'agents_expected:', 'agents_completed:']:
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
if d.get('verdict') == 'error':
    reason = d.get('error_reason', 'unknown')
    print('observe-result.json verdict is error: %s' % reason, file=sys.stderr); sys.exit(1)
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
  git add -A
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "$(cat "$COMMIT_MSG")"
  fi
  # Large initial commits (bootstrap: 170+ files) can exceed default http.postBuffer (1MB)
  git config --local http.postBuffer 52428800  # 50MB
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

    # Guard 3: template-lint parity. Runs the same validators CI runs on
    # template files. Dispatches by diff type to keep the common case fast:
    #   - .claude/ / .github/workflows/ / Makefile touched -> make lint-template (~1-3s)
    #   - scripts/ touched (validator code or shell tools) -> make lint-template-full (~50s, includes pytest)
    #   - pure src/ -> skip (covered by local /verify)
    #   - diff detection fails -> run lint-template-full (fail-closed)
    # Uses git diff (local, no network) instead of gh pr diff (silent-fails on
    # auth/network blip and would bypass the gate, same class as the bug we fixed).
    # DO_NOT add --auto to the merge command below: repo allow_auto_merge=false
    # makes --auto silently become an immediate non-gated merge. See issue #1003
    # and feedback_gh_pr_merge_auto_fallback memory.
    if [[ -z "$SKIP_MERGE" ]] && command -v make >/dev/null 2>&1; then
      LINT_TARGET=""
      MERGE_BASE=$(git merge-base origin/main HEAD 2>/dev/null || git merge-base main HEAD 2>/dev/null || echo "")
      if [[ -z "$MERGE_BASE" ]]; then
        LINT_TARGET="lint-template-full"
        echo "INFO: merge-base not resolvable — running lint-template-full (fail-closed)" >&2
      else
        DIFF_FILES=$(git diff --name-only "$MERGE_BASE..HEAD" 2>/dev/null || echo "")
        if [[ -z "$DIFF_FILES" ]]; then
          LINT_TARGET="lint-template-full"
          echo "INFO: diff empty/unreadable — running lint-template-full (fail-closed)" >&2
        elif echo "$DIFF_FILES" | grep -qE '^scripts/'; then
          LINT_TARGET="lint-template-full"
        elif echo "$DIFF_FILES" | grep -qE '^\.claude/|^\.github/workflows/|^Makefile$'; then
          LINT_TARGET="lint-template"
        fi
      fi
      if [[ -n "$LINT_TARGET" ]]; then
        if ! make "$LINT_TARGET" >&2; then
          echo "INFO: make $LINT_TARGET failed — skipping auto-merge" >&2
          SKIP_MERGE="template-lint"
        fi
      fi
    fi

    # Merge
    if [[ -z "$SKIP_MERGE" ]]; then
      FEATURE_BRANCH=$(git branch --show-current)
      if [[ "$(bash .claude/scripts/lib/in-worktree.sh)" == "true" ]]; then
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
    if [[ -z "$SKIP_MERGE" && "$(bash .claude/scripts/lib/in-worktree.sh)" == "false" ]]; then
      git checkout main && git pull
      git branch -d "$FEATURE_BRANCH" 2>/dev/null || true
    fi

    if [[ -z "$SKIP_MERGE" ]]; then
      DELIVERY_STATUS="merged"
      echo "DELIVERY=merged"
    else
      DELIVERY_STATUS="pr-created:$SKIP_MERGE"
      echo "DELIVERY=pr-created:$SKIP_MERGE"
    fi
  else
    # commit+push only — no PR (bootstrap pattern)
    DELIVERY_STATUS="pushed"
    echo "DELIVERY=pushed"
  fi
else
  # No delivery artifacts — analysis skill
  echo "DELIVERY=none"
fi

# --- Step 6: Write verify-recheck.json for remediation phase ---
# Assembles final structured artifact from Step 2 raw results + missing states + delivery status.
python3 -c "
import json, sys, os

project_dir = '$PROJECT_DIR'
ctx_path = '$CTX'
manifest_path = '$MANIFEST'
delivery_status = '$DELIVERY_STATUS'

result = {
    'skill': '$SKILL',
    'missing_states': [],
    'verify_results': [],
    'total': 0,
    'passed': 0,
    'failed': 0,
    'delivery_status': delivery_status
}

# Read raw verify results from Step 2
raw_path = os.path.join(project_dir, '.runs/.verify-results-raw.json')
if os.path.isfile(raw_path):
    try:
        result['verify_results'] = json.load(open(raw_path))
        result['total'] = len(result['verify_results'])
        result['passed'] = sum(1 for r in result['verify_results'] if r.get('passed'))
        result['failed'] = result['total'] - result['passed']
    except: pass

# Compute missing_states (same logic as Step 1)
try:
    ctx = json.load(open(ctx_path))
    completed = set(str(s) for s in ctx.get('completed_states', []))
    skip = set(str(s) for s in ctx.get('skip_states', []))
    manifest = json.load(open(manifest_path))
    if 'active_mode' in manifest and 'modes' in manifest:
        states = manifest['modes'][manifest['active_mode']]['states']
    else:
        states = manifest.get('states', [])
    result['missing_states'] = [str(s) for s in states if str(s) not in completed and str(s) not in skip]
except: pass

outpath = os.path.join(project_dir, '.runs/verify-recheck.json')
try:
    json.dump(result, open(outpath, 'w'), indent=2)
    print('INFO: Wrote verify-recheck.json (%d passed, %d failed)' % (result['passed'], result['failed']), file=sys.stderr)
except Exception as e:
    print('WARN: Failed to write verify-recheck.json: %s' % e, file=sys.stderr)
" || echo "WARN: verify-recheck.json assembly failed — remediation phase will have no structured input" >&2

# --- Step 7: Teardown transient local services started by this skill ---
# Stops skill-owned Supabase stacks matching the current run_id (or an ancestor
# run_id for /change->embed /verify). No-op in CI and when the stack combo is
# not supabase+playwright. See .claude/scripts/stop-transient-services.sh.
# Writes <git-common-dir>/finalize-completed-<run_id>.flag AFTER stop succeeds
# so that a crash between Step 6 and Step 7 is detected by the next skill's
# lifecycle-init.sh Step 0.5.
TEARDOWN_RUN_ID=$(python3 -c "import json; print(json.load(open('$CTX')).get('run_id',''))" 2>/dev/null || echo "")
TEARDOWN_COMMON_DIR=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")
if [[ -n "$TEARDOWN_RUN_ID" && -n "$TEARDOWN_COMMON_DIR" ]]; then
  bash "$PROJECT_DIR/.claude/scripts/stop-transient-services.sh" --for-run "$TEARDOWN_RUN_ID" 2>&1 | sed 's/^/[teardown] /' || \
    echo "WARN: transient-service teardown failed (non-blocking)" >&2
  touch "$TEARDOWN_COMMON_DIR/finalize-completed-$TEARDOWN_RUN_ID.flag" 2>/dev/null || true
fi

echo "FINALIZE_COMPLETE"
