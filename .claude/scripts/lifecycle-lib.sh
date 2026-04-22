#!/usr/bin/env bash
# lifecycle-lib.sh — Shared functions for lifecycle scripts.
# Facade: sourced by lifecycle-finalize.sh, lifecycle-next.sh, advance-state.sh,
# and state-completion-gate.sh. Provides unified context path, registry key,
# and skill directory resolution with mode awareness.
#
# Requires: caller sets PROJECT_DIR before calling any function.

# --- resolve_context_path <skill> [manifest_path] ---
# Outputs the full context file path to stdout.
# - verify → .runs/verify-context.json
# - manifest with active_mode (non-empty, non-"default") → .runs/{skill}-{mode}-context.json
# - fallback → .runs/{skill}-context.json
resolve_context_path() {
  local skill="$1"
  local manifest="${2:-}"

  if [[ "$skill" == "verify" ]]; then
    echo "$PROJECT_DIR/.runs/verify-context.json"
    return
  fi

  if [[ -n "$manifest" && -f "$manifest" ]]; then
    local ctx_skill
    ctx_skill=$(python3 -c "
import json
m=json.load(open('$manifest'))
am=m.get('active_mode','')
sk='$skill'
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$skill")
    echo "$PROJECT_DIR/.runs/${ctx_skill}-context.json"
  else
    echo "$PROJECT_DIR/.runs/${skill}-context.json"
  fi
}

# --- resolve_registry_key <skill> [manifest_path] ---
# Outputs the state-registry.json lookup key to stdout.
# - manifest with active_mode (non-empty, non-"default") → {skill}-{mode}
# - fallback → {skill}
resolve_registry_key() {
  local skill="$1"
  local manifest="${2:-}"

  if [[ -n "$manifest" && -f "$manifest" ]]; then
    python3 -c "
import json
m=json.load(open('$manifest'))
am=m.get('active_mode','')
sk='$skill'
print('%s-%s'%(sk,am) if am and am!='default' else sk)
" 2>/dev/null || echo "$skill"
  else
    echo "$skill"
  fi
}

# --- resolve_skill_dir <skill> ---
# Outputs "{directory} {mode}" or just "{directory}" to stdout.
# Maps mode-qualified skill names to their .claude/skills/ directory and mode.
# - iterate-check → iterate check
# - iterate-cross → iterate cross
# - fallback → {skill}
resolve_skill_dir() {
  local skill="$1"
  case "$skill" in
    iterate-check) echo "iterate check" ;;
    iterate-cross) echo "iterate cross" ;;
    *) echo "$skill" ;;
  esac
}

# --- resolve_framework_manifest <skill> ---
# Outputs the framework-owned manifest path (stdout).
# Canonical path: .runs/<skill>-lifecycle.json
#
# The framework manifest (JSON mirror of skill.yaml) and skill domain manifests
# (deploy/iterate/audit outputs) are now on separate paths — framework writes
# -lifecycle.json, domain writes -manifest.json (issue #1006). Callers should
# use this helper instead of hardcoding the path so the migration-compat branch
# (below) is consulted uniformly.
#
# Migration compat (REMOVE per issue #1027, scheduled 2026-05-22):
# During the release cycle following the rename, a pre-upgrade run may have left
# its framework manifest at the legacy path .runs/<skill>-manifest.json. If the
# canonical path is absent AND the legacy path exists AND contains any framework-
# exclusive key (states/modes/agents/embed/loop — none appear in any known domain
# schema: deploy uses name/canonical_url/hosting/database, iterate uses
# experiment_id/round/verdict, audit uses scope/findings/delta), fall back to the
# legacy path with a one-line stderr warning so the in-flight run can complete.
# This is read-side only — writers always target the canonical path.
resolve_framework_manifest() {
  local skill="$1"
  local new_path="$PROJECT_DIR/.runs/${skill}-lifecycle.json"
  local legacy_path="$PROJECT_DIR/.runs/${skill}-manifest.json"

  if [[ ! -f "$new_path" && -f "$legacy_path" ]] && python3 -c "
import json, sys
try:
    d = json.load(open('$legacy_path'))
    sys.exit(0 if isinstance(d, dict) and any(
        k in d for k in ('states', 'modes', 'agents', 'embed', 'loop')
    ) else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
    echo "[lifecycle] Using legacy manifest path $legacy_path (pre-upgrade run) — please reset .runs/ after this run completes." >&2
    echo "$legacy_path"
  else
    echo "$new_path"
  fi
}
