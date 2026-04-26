#!/usr/bin/env bash
# lib-verdict-consistency.sh — Verdict / fix-log consistency checks.
# Sourced via lib.sh facade. Do NOT source directly.
# Requires: ERRORS array (from caller).
# Cross-module: read_json_field (lib-core.sh).

# --- check_verdict_error ---
# Unconditionally rejects verdict "error" in observe-result.json.
# Placed BEFORE check_verdict_consistency because that function has early-return
# guards on diffs existence — process-scope skills (e.g., /solve) with no diffs
# would bypass it. This function has NO early-return guards.
# Appends to global ERRORS array. Does not exit — caller decides.
# Usage: check_verdict_error
check_verdict_error() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local obs_file="$project_dir/.runs/observe-result.json"

  [[ ! -f "$obs_file" ]] && return 0

  local verdict
  verdict=$(read_json_field "$obs_file" "verdict")

  if [[ "$verdict" == "error" ]]; then
    local reason
    reason=$(read_json_field "$obs_file" "error_reason")
    ERRORS+=("Observation failed with verdict 'error': ${reason:-unknown reason}. Re-run the skill to retry observation.")
  fi
}

# --- check_fixlog_verdict_consistency (AOC v1 FLS v1 canonical) ---
# Blocks if: fix-ledger.jsonl has entries (or, transitional fallback,
# fix-log.md has entries) but verdict is "clean" (not execution-audit).
# Catches the case where observation-phase.md was skipped but agents
# produced fixes that went unobserved.
# Appends to global ERRORS array. Does not exit — caller decides.
# Usage: check_fixlog_verdict_consistency
check_fixlog_verdict_consistency() {
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local obs_file="$project_dir/.runs/observe-result.json"
  local ledger="$project_dir/.runs/fix-ledger.jsonl"
  local fixlog="$project_dir/.runs/fix-log.md"

  [[ ! -f "$obs_file" ]] && return 0

  # Authoritative count: ledger row count (one JSON per line).
  # Transitional fallback: prose fix-log non-empty non-header lines.
  local entry_count=0
  if [[ -f "$ledger" ]]; then
    entry_count=$(grep -c -v '^\s*$' "$ledger" 2>/dev/null || echo "0")
  elif [[ -f "$fixlog" ]]; then
    entry_count=$(grep -c -v '^\s*$\|^#' "$fixlog" 2>/dev/null || echo "0")
  fi
  [[ "$entry_count" -eq 0 ]] && return 0

  local verdict strategy
  verdict=$(read_json_field "$obs_file" "verdict")
  strategy=$(read_json_field "$obs_file" "strategy")

  if [[ "$verdict" == "clean" ]] && [[ "$strategy" != "execution-audit" ]]; then
    ERRORS+=("Verdict inconsistency: fix ledger/log has $entry_count entries but verdict is 'clean'. Observation was skipped or incomplete.")
  fi
}

# --- check_verdict_consistency ---
# Checks that observe-result.json verdict is consistent with observer-diffs.txt content.
# Blocks if: non-empty diffs + verdict "clean" + not execution-audit + not dry-run.
# Appends to global ERRORS array. Does not exit — caller decides.
# Usage: check_verdict_consistency "$SKILL"
check_verdict_consistency() {
  local skill="$1"
  local project_dir="${CLAUDE_PROJECT_DIR:-.}"
  local diffs_file="$project_dir/.runs/observer-diffs.txt"
  local obs_file="$project_dir/.runs/observe-result.json"
  local ctx_file="$project_dir/.runs/${skill}-context.json"

  # Only check if both files exist and diffs is non-empty
  [[ ! -f "$diffs_file" ]] && return 0
  [[ ! -s "$diffs_file" ]] && return 0
  [[ ! -f "$obs_file" ]] && return 0

  local verdict strategy dry_run
  verdict=$(read_json_field "$obs_file" "verdict")
  strategy=$(read_json_field "$obs_file" "strategy")
  dry_run=$(read_json_field "$ctx_file" "dry_run")

  # Invariant: non-empty diffs + "clean" verdict + Strategy A = violation
  if [[ "$verdict" == "clean" ]] && [[ "$strategy" != "execution-audit" ]] && [[ "$dry_run" != "True" ]]; then
    ERRORS+=("Verdict inconsistency: observer-diffs.txt has content but observe-result.json verdict is 'clean' — the observer was not spawned. Re-run the skill epilogue.")
  fi
}
