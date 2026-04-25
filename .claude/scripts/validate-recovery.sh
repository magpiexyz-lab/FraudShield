#!/usr/bin/env bash
# validate-recovery.sh — Validate a recovery/self-degraded trace against
# independent evidence (build + e2e + diff-fix correlation).
#
# Used by verify STATE 7a before writing verify-report.md. Stamps
# recovery_validated:true on the trace when all three evidence checks pass.
# This transforms `recovery:true` from an automatic hard-fail into an audit
# marker that verify-report-gate.sh can safely allow under hard_gate_failure:false.
#
# Usage: bash .claude/scripts/validate-recovery.sh <trace-filename-without-ext>
# Example: bash .claude/scripts/validate-recovery.sh design-critic
# Example: bash .claude/scripts/validate-recovery.sh design-critic-landing
#
# Exit codes:
#   0 — all evidence checks passed; recovery_validated stamped true
#   1 — at least one evidence check failed; recovery_validated stays false
#   2 — prerequisite error (trace missing, malformed, etc)
#
# Evidence checks:
#   1. .runs/build-result.json.exit_code == 0
#   2. .runs/e2e-result.json.passed == true (if tests are in scope for archetype)
#   3. Every fixes[].file appears in git diff output. Diff set:
#        - Normal agent: `git diff --name-only <spawn_sha>..HEAD` UNION `git status --porcelain`
#        - lead-merge worktree: merge commit diff (deferred — current impl uses spawn_sha..HEAD)
#      OR no_fixes_claimed:true AND agent ∈ non_fixer_agents AND at least one
#      non-degraded sibling trace exists (findings-only agents).
set -euo pipefail

TRACE_NAME="${1:?Usage: validate-recovery.sh <trace-filename-without-ext>}"

PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || echo "${CLAUDE_PROJECT_DIR:-.}")"
TRACE_PATH="$PROJECT_DIR/.runs/agent-traces/$TRACE_NAME.json"
BUILD_RESULT="$PROJECT_DIR/.runs/build-result.json"
E2E_RESULT="$PROJECT_DIR/.runs/e2e-result.json"
REGISTRY="$PROJECT_DIR/.claude/patterns/agent-registry.json"

if [[ ! -f "$TRACE_PATH" ]]; then
  echo "ERROR: validate-recovery.sh — trace not found: $TRACE_PATH" >&2
  exit 2
fi

TRACE_PATH_ENV="$TRACE_PATH" BUILD_RESULT_ENV="$BUILD_RESULT" E2E_RESULT_ENV="$E2E_RESULT" \
REGISTRY_ENV="$REGISTRY" PROJECT_DIR_ENV="$PROJECT_DIR" python3 - << 'PYEOF'
import json, os, subprocess, sys

trace_path = os.environ['TRACE_PATH_ENV']
build_path = os.environ['BUILD_RESULT_ENV']
e2e_path = os.environ['E2E_RESULT_ENV']
reg_path = os.environ['REGISTRY_ENV']
project = os.environ['PROJECT_DIR_ENV']

try:
    trace = json.load(open(trace_path))
except Exception as exc:
    sys.stderr.write(f'ERROR: cannot parse trace: {exc}\n')
    sys.exit(2)

provenance = trace.get('provenance')
# AOC v1.1: lead-on-behalf goes through validation too. The agent reported
# success but the lead transcribed its output; downstream gates require
# independent evidence (build + e2e + diff-fix correlation) to stamp
# recovery_validated:true. lead-synthesized and lead-fix have their own
# attestation paths (coverage_provider / lead_attestation) and don't go
# through this evidence loop.
if provenance not in ('recovery', 'self-degraded', 'lead-on-behalf'):
    sys.stderr.write(f'SKIP: trace provenance={provenance!r} — only recovery/self-degraded/lead-on-behalf need validation\n')
    sys.exit(0)

errors = []

# Evidence 1: build
try:
    br = json.load(open(build_path))
    ec = br.get('exit_code')
    if ec != 0:
        errors.append(f'build-result.json exit_code={ec} (need 0)')
except FileNotFoundError:
    errors.append('build-result.json missing — run the build before validating')
except Exception as exc:
    errors.append(f'build-result.json malformed: {exc}')

# Evidence 2: e2e (skip if not applicable — heuristic: file exists means tests in scope)
# Agent-role carve-out: read-only (non-fixer) agents produce analysis, not fixes.
# e2e outcome is not semantically coupled to whether their scan completed correctly,
# so we skip the e2e precondition for any agent listed in agent-registry.json
# non_fixer_agents. This prevents the deadlock where every read-only agent's trace
# gets stuck at recovery_validated:false during bootstrap-verify (issue #1046).
try:
    reg = json.load(open(reg_path))
    non_fixers = set(reg.get('non_fixer_agents', []))
except Exception:
    non_fixers = set()

agent_for_role_check = trace.get('agent', '')
is_non_fixer = agent_for_role_check in non_fixers

if os.path.isfile(e2e_path) and not is_non_fixer:
    try:
        er = json.load(open(e2e_path))
        # Accept either passed:true or skipped:true
        if not (er.get('passed') is True or er.get('skipped') is True):
            errors.append(f'e2e-result.json shows failure (passed={er.get("passed")}, skipped={er.get("skipped")})')
    except Exception as exc:
        errors.append(f'e2e-result.json malformed: {exc}')
# If e2e-result.json is missing OR agent is a non-fixer, don't fail on e2e evidence

# Evidence 3: diff-fix correlation
fixes = trace.get('fixes') or []
agent_base = (trace.get('agent') or '').split('-')[0] if '-' in (trace.get('agent') or '') else (trace.get('agent') or '')
# Resolve base agent from trace.agent; for per-page traces agent stays the base
agent = trace.get('agent', '')

if fixes:
    # Compute diff file set: spawn_sha..HEAD UNION porcelain untracked/modified
    spawn_sha = trace.get('spawn_sha', '')
    diff_files = set()
    if spawn_sha:
        try:
            out = subprocess.check_output(
                ['git', 'diff', '--name-only', f'{spawn_sha}..HEAD'],
                cwd=project, text=True, stderr=subprocess.DEVNULL)
            diff_files.update(f for f in out.splitlines() if f)
        except subprocess.CalledProcessError:
            # If spawn_sha isn't reachable (e.g., shallow clone), fall back to HEAD~..HEAD
            try:
                out = subprocess.check_output(
                    ['git', 'diff', '--name-only', 'HEAD~..HEAD'],
                    cwd=project, text=True, stderr=subprocess.DEVNULL)
                diff_files.update(f for f in out.splitlines() if f)
            except subprocess.CalledProcessError:
                pass
    # Porcelain (covers modified + untracked). --untracked-files=all is
    # required: the default collapses untracked directories to a single
    # entry (e.g., "?? public/"), hiding the actual new files that fixer
    # agents create.
    try:
        out = subprocess.check_output(
            ['git', 'status', '--porcelain', '--untracked-files=all'],
            cwd=project, text=True, stderr=subprocess.DEVNULL)
        for line in out.splitlines():
            # Format: "XY path" where XY is 2 chars + space
            if len(line) > 3:
                diff_files.add(line[3:].strip().strip('"'))
    except subprocess.CalledProcessError:
        pass

    # Every fix's file must appear in diff_files
    missing = []
    for fix in fixes:
        f = fix.get('file') if isinstance(fix, dict) else None
        if not f:
            continue  # skip malformed fix entries — schema gate catches these
        if f not in diff_files:
            # Check prefix match in case of path mismatch (e.g., leading ./)
            if not any(d == f or d.endswith('/' + f) or f.endswith('/' + d) for d in diff_files):
                missing.append(f)
    if missing:
        errors.append(f'fixes[].file not present in diff: {missing}')
elif trace.get('no_fixes_claimed') is True:
    # Findings-only path: agent must be in non_fixer_agents. To confirm scope
    # actually executed, require either (a) a non-degraded sibling trace, OR
    # (b) build-result.json shows success — the latter covers the case where
    # every agent in a session self-degrades (e.g., guard blocks all trace
    # writes, see #1045) and no non-degraded sibling exists. Issue #1046.
    if agent not in non_fixers:
        errors.append(f'no_fixes_claimed:true requires agent in non_fixer_agents (got {agent!r})')
    # Check sibling traces: any trace in agent-traces/ with provenance=self
    traces_dir = os.path.join(project, '.runs', 'agent-traces')
    sibling_ok = False
    if os.path.isdir(traces_dir):
        for fn in os.listdir(traces_dir):
            if not fn.endswith('.json'):
                continue
            if fn == os.path.basename(trace_path):
                continue
            try:
                s = json.load(open(os.path.join(traces_dir, fn)))
            except Exception:
                continue
            if s.get('provenance') == 'self' and s.get('verdict') in ('pass', 'fail'):
                sibling_ok = True
                break
    if not sibling_ok:
        # Fallback: accept when the session's build succeeded
        build_ok = False
        try:
            br = json.load(open(build_path))
            build_ok = br.get('exit_code') == 0
        except Exception:
            pass
        if not build_ok:
            errors.append('no_fixes_claimed:true requires at least one non-degraded sibling trace OR a successful build-result.json')
else:
    # Neither fixes[] nor no_fixes_claimed:true — fixer agents need one or the other
    errors.append('recovery/self-degraded trace must have either fixes[] array or no_fixes_claimed:true')

if errors:
    sys.stderr.write('validate-recovery.sh FAIL:\n')
    for e in errors:
        sys.stderr.write(f'  - {e}\n')
    sys.exit(1)

# All evidence passed — stamp recovery_validated:true
trace['recovery_validated'] = True
json.dump(trace, open(trace_path, 'w'), indent=2)
print(f'validate-recovery.sh PASS: {trace_path} recovery_validated:true stamped')
PYEOF
