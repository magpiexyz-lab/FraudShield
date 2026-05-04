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
    'run_id': '${RUN_ID:-unknown}',
    'fast_path': False, 'error': 'script exited unexpectedly',
    'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open('$RUNS_DIR/observation-enforcement.json', 'w'), indent=2)
" 2>/dev/null || true
  fi
}
trap _write_fallback_artifact EXIT

# ── Derive skill name ──
# Primary: accept active skill as $1 from the caller (fix #1071/def1). This is
# the ONLY deterministic source — glob.glob() below returns results in
# arbitrary filesystem order, so files[0] can be a stale spec-context.json
# from an earlier /spec run. Caller at .claude/patterns/state-99-epilogue.md
# passes "$SKILL_KEY" already derived at that pattern's Step 4.
# Fallback: mtime-sorted glob for defense-in-depth (older callers that don't
# yet pass the arg). The mtime fallback is not 100% reliable but beats the
# indeterminate filesystem ordering we used before.
SKILL="${1:-}"
if [[ -z "$SKILL" ]]; then
  # #1268: same active-context discovery as observation-phase.md Step 5b.
  # Exclude epilogue-context.json; partition by completed; prefer newest
  # non-completed; staleness floor = if non-completed >60 min older than
  # newest completed, prefer the completed (defense against stale crashed
  # contexts vs fresh completed siblings). The two callsites must stay in
  # sync — observation-phase reads SKILL/RUN_ID for compliance-audit, and
  # this script writes SKILL/RUN_ID for observe-evidence-check; divergence
  # would propagate the wrong skill into compliance scoring.
  SKILL=$(python3 -c "
import json, glob, os
RUNS_DIR='$RUNS_DIR'
candidates = []
for f in glob.glob(RUNS_DIR + '/*-context.json'):
    if os.path.basename(f) == 'epilogue-context.json':
        continue
    try:
        ctx = json.load(open(f))
    except Exception:
        continue
    try:
        mtime = os.path.getmtime(f)
    except OSError:
        continue
    candidates.append((f, mtime, bool(ctx.get('completed', False)), ctx))
non_completed = sorted([c for c in candidates if not c[2]], key=lambda x: x[1], reverse=True)
completed     = sorted([c for c in candidates if c[2]],     key=lambda x: x[1], reverse=True)
chosen = None
if non_completed:
    chosen = non_completed[0]
    if completed and completed[0][1] - chosen[1] > 3600:
        chosen = completed[0]
elif completed:
    chosen = completed[0]
print((chosen[3].get('skill') if chosen else None) or 'unknown')
" 2>/dev/null || echo "unknown")
fi

# ── Resolve RUN_ID for the active SKILL (GRAIM v2 C1+C2) ──
# Caller-passed $SKILL is authoritative. Mirror state-completion-gate.sh:79-91:
# caller wins; resolve_active_identity is a warn-only cross-check.
RUN_ID=""
if [ -n "$SKILL" ] && [ -f "$RUNS_DIR/${SKILL}-context.json" ]; then
  RUN_ID=$(python3 -c "import json,sys;print(json.load(open('$RUNS_DIR/${SKILL}-context.json')).get('run_id',''))" 2>/dev/null || echo "")
fi
# Cross-check via resolve_active_identity (warn-only, mirror state-completion-gate.sh:79-91)
if [ -n "$RUN_ID" ]; then
  ACTIVE_IDENTITY="$(bash -c 'source .claude/hooks/lib.sh && resolve_active_identity' 2>/dev/null || true)"
  if [ -n "$ACTIVE_IDENTITY" ]; then
    IFS=$'\t' read -r _COA_ACT_SKILL _COA_ACT_RUN_ID _ _ <<< "$ACTIVE_IDENTITY"
    if [ -n "$_COA_ACT_RUN_ID" ] && [ "$_COA_ACT_RUN_ID" != "$RUN_ID" ]; then
      echo "WARN: check-observation-artifacts: caller-RUN_ID='$RUN_ID' but resolve_active_identity returned '$_COA_ACT_RUN_ID' — possible stale context" >&2
    fi
    unset _COA_ACT_SKILL _COA_ACT_RUN_ID
  fi
fi

# ── Early exit: optimize-prompt (no observation) ──
if [[ "$SKILL" == "optimize-prompt" ]]; then
  python3 -c "
import json, datetime
json.dump({
    'pass': True, 'missing': [], 'scope': 'n/a', 'skill': 'optimize-prompt',
    'run_id': '${RUN_ID:-unknown}',
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
    # Accept both dict-shape (legacy) and list-of-dicts shape (current) for
    # embed. Issue #1127: list-of-dicts was introduced to allow multiple embed
    # points; the scope detector silently fell through to scope=code on every
    # bootstrap/change/distribute/resolve/review run since.
    embed = data.get('embed')
    embed_entries = []
    if isinstance(embed, dict):
        embed_entries = [embed]
    elif isinstance(embed, list):
        embed_entries = [e for e in embed if isinstance(e, dict)]
    if any(e.get('skill') == 'verify' for e in embed_entries):
        has_embed_verify = True
    agents = data.get('agents', {})
    CRITIC_AGENTS = {'solve-critic', 'resolve-challenger', 'review-challenger'}
    if isinstance(agents, dict):
        has_critic = bool(CRITIC_AGENTS & set(agents.keys()))
except ImportError:
    # Fallback: regex-based parsing. Must accept both shapes -- see #1127.
    # Pattern matches ^embed:, then optional list-of-dicts intermediate keys,
    # then an indented skill verify line (with or without leading dash).
    import re
    try:
        content = open(skill_yaml_path).read()
        if re.search(
            r'(?ms)^embed:\s*\n(?:\s*-?\s*[a-z_]+:.*\n)*?\s*-?\s*skill:\s*verify',
            content,
        ):
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

    # hook-friction-summary.json — required for full/process scope when
    # .runs/hook-friction.jsonl has rows for the current run_id (#1226).
    # Without the summary, the lead Q2 retrospective is missing its 4th
    # evidence channel and tends to produce falsely-clean process_compliance.
    # Filter by run_id to avoid penalizing future runs that inherit a
    # historical jsonl with no current-run rows.
    FRICTION_RUN_ROWS=$(python3 -c "
import json, os
fp = '$RUNS_DIR/hook-friction.jsonl'
rid = '$RUN_ID'
if not os.path.isfile(fp) or os.path.getsize(fp) == 0 or not rid:
    print(0)
else:
    n = 0
    try:
        with open(fp) as f:
            for line in f:
                line = line.strip()
                if not line: continue
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                if e.get('run_id') == rid:
                    n += 1
    except Exception:
        n = 0
    print(n)
" 2>/dev/null || echo "0")
    if [[ "$FRICTION_RUN_ROWS" != "0" ]] && [[ ! -f "$RUNS_DIR/hook-friction-summary.json" ]]; then
      MISSING+=("hook-friction-summary.json")
      echo "WARN: observation-enforcement: missing hook-friction-summary.json — $FRICTION_RUN_ROWS run-scoped friction event(s) need Q2 4th evidence channel (#1226). lifecycle-finalize.sh Step 2.6 should aggregate." >&2
    fi

    # Hard-gate enforcement (fix #1066): when hard_gate_failure=true, the
    # retrospective MUST have populated Q1/Q2/Q3 fields — sentinel entries are
    # allowed for degraded evidence, but empty arrays / 'skipped-hard-gate'
    # sentinel values are NOT. The inverse-policy in observation-phase.md
    # Step 5a requires the lead to execute the full retrospective when a hard
    # gate fires, not to self-silence it.
    if [[ -f "$RUNS_DIR/retrospective-result.json" ]]; then
      CTX_HARD_GATE=$(python3 -c "
import json, glob
for f in glob.glob('$RUNS_DIR/*-context.json'):
    if 'epilogue' in f: continue
    try:
        d = json.load(open(f))
        if d.get('hard_gate_failure') is True:
            print('true')
            break
    except Exception:
        pass
" 2>/dev/null || true)
      if [[ "$CTX_HARD_GATE" == "true" ]]; then
        RETRO_OK=$(python3 -c "
import json
try:
    d = json.load(open('$RUNS_DIR/retrospective-result.json'))
    pc = d.get('process_compliance', '')
    aic = d.get('agent_instruction_compliance', [])
    tf = d.get('trace_fidelity', '')
    # Reject the legacy skipped-hard-gate sentinel; require non-empty populated fields.
    ok = (pc and pc != 'skipped-hard-gate' and
          isinstance(aic, list) and len(aic) > 0 and
          tf and tf != 'skipped-hard-gate' and
          d.get('skipped') is not True)
    print('ok' if ok else 'bad')
except Exception:
    print('bad')
" 2>/dev/null || echo "bad")
        if [[ "$RETRO_OK" != "ok" ]]; then
          MISSING+=("retrospective-result.json (populated Q1/Q2/Q3 required on hard_gate_failure)")
          echo "WARN: observation-enforcement: hard_gate_failure=true but retrospective-result.json has empty or skipped-hard-gate fields — Step 5a required path not executed (#1066)" >&2
        fi
      fi
    fi
  fi
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  PASS="false"
fi

# ── Retrospective-completeness gate (#1276) ──
# Runs AFTER observation-phase Step 5a has written retrospective-result.json
# (contrast: lifecycle-finalize.sh Step 1 runs BEFORE observation, so the
# validator must be wired here, not there). Fail-mode: when validator returns
# non-zero AND RETROSPECTIVE_COMPLETENESS_MODE=deny, add to MISSING so the
# observation-enforcement.json `pass` field flips to false and state-99 VERIFY
# blocks. Default MODE=warn during rollout — only logs to stderr.
if [[ "$SCOPE" == "full" || "$SCOPE" == "process" ]] \
   && [[ -f "$RUNS_DIR/retrospective-pending-findings.json" ]]; then
  RC_OUT=$(python3 "${PROJECT_DIR}/.claude/scripts/validate-retrospective-completeness.py" 2>&1) || RC_RC=$?
  RC_RC="${RC_RC:-0}"
  if [[ "$RC_RC" -ne 0 ]]; then
    echo "$RC_OUT" >&2
    if [[ "${RETROSPECTIVE_COMPLETENESS_MODE:-warn}" == "deny" ]]; then
      MISSING+=("retrospective-completeness (#1276 — pending findings without disposition)")
      PASS="false"
    fi
  fi
fi

# ── Write audit artifact (delegates to canonical writer — GRAIM v2 Slice 3) ──
# Build missing list as newline-delimited string, then convert in Python
MISSING_STR=""
for m in "${MISSING[@]+"${MISSING[@]}"}"; do
  MISSING_STR="${MISSING_STR}${m}"$'\n'
done

# Build payload (without identity fields — write-gate-artifact.sh stamps them)
PAYLOAD=$(MISSING_STR_ENV="$MISSING_STR" SCOPE_ENV="$SCOPE" FAST_PATH_ENV="$FAST_PATH" python3 <<'PYEOF'
import json, os
missing_raw = os.environ['MISSING_STR_ENV'].strip()
missing = [m for m in missing_raw.split('\n') if m] if missing_raw else []
payload = {
    'pass': len(missing) == 0,
    'missing': missing,
    'scope': os.environ['SCOPE_ENV'],
    'fast_path': os.environ['FAST_PATH_ENV'] == 'true',
}
print(json.dumps(payload))
PYEOF
)
bash "${PROJECT_DIR}/.claude/scripts/lib/write-gate-artifact.sh" \
  --path "${RUNS_DIR}/observation-enforcement.json" \
  --payload "$PAYLOAD" \
  --skill "$SKILL"

exit 0
