#!/usr/bin/env bash
set -euo pipefail

# check-archetype-consistency.sh — Verify archetype branching references are
# standardized across all files that contain archetype-conditional logic.
#
# Canonical source: .claude/patterns/archetype-behavior-check.md (Quick-Reference Table)
# Full table: files <6KB with archetype branching embed the inline table
# REF-only: files >6KB reference the canonical source

ERRORS=0
WARNINGS=0

check_present() {
  local file="$1" pattern="$2" desc="$3"
  [ -f "$file" ] || { echo "FAIL: $file — file not found"; ERRORS=$((ERRORS + 1)); return; }
  if ! grep -qE "$pattern" "$file"; then
    echo "FAIL: $file — $desc"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "=== Archetype Consistency Check ==="
echo ""

# 1. Canonical source has Quick-Reference Table
check_present ".claude/patterns/archetype-behavior-check.md" \
  'Quick-Reference Table' \
  "missing Quick-Reference Table section"

# 2. Canonical source table has all 3 archetypes
check_present ".claude/patterns/archetype-behavior-check.md" \
  'web-app.*service.*cli' \
  "Quick-Reference Table missing archetype columns"

# 3. Full-table files contain the inline table marker
FULL_TABLE_FILES=(
  ".claude/patterns/bootstrap/state-14-wire-phase.md"
  ".claude/patterns/bootstrap/state-13-merged-validation.md"
  ".claude/patterns/change/state-9-update-specs.md"
  ".claude/patterns/change/state-11-verify.md"
  ".claude/patterns/deploy/state-4a-health-fix.md"
  ".claude/patterns/spec/state-4-golden-path.md"
  ".claude/patterns/spec/state-6-stack-funnel.md"
  ".claude/patterns/teardown/state-0-pre-flight.md"
  ".claude/procedures/change-test.md"
  ".claude/procedures/accessibility-scanner.md"
  ".claude/procedures/plan-validation.md"
  ".claude/procedures/scaffold-libs.md"
  ".claude/procedures/scaffold-landing.md"
  ".claude/agents/performance-reporter.md"
  ".claude/agents/security-defender.md"
  ".claude/patterns/bootstrap/state-13c-bg2-gate.md"
  ".claude/patterns/bootstrap/state-9-setup-phase.md"
  ".claude/patterns/bootstrap/state-18-commit-and-push.md"
  ".claude/patterns/retro/state-3-file-issue.md"
  ".claude/agents/provision-scanner.md"
  ".claude/patterns/iterate/state-0-read-context.md"
  ".claude/patterns/change/state-12-commit-and-pr.md"
)

for f in "${FULL_TABLE_FILES[@]}"; do
  check_present "$f" 'Primary unit.*page.*endpoint.*command' \
    "should contain inline archetype table"
done

# 4. REF-only files reference archetype-behavior-check.md
REF_ONLY_FILES=(
  ".claude/procedures/wire.md"
  ".claude/procedures/change-plans.md"
  ".claude/procedures/change-feature.md"
  ".claude/procedures/behavior-verifier.md"
  ".claude/procedures/scaffold-pages.md"
  ".claude/agents/gate-keeper.md"
  ".claude/agents/behavior-verifier.md"
  ".claude/hooks/agent-state-gate.sh"
  ".claude/stacks/framework/nextjs.md"
  ".claude/patterns/change/state-10-implement.md"
  ".claude/patterns/iterate/state-4-output.md"
  ".claude/patterns/security-review.md"
  ".claude/patterns/audit/state-1-parallel-analysis.md"
  ".claude/patterns/bootstrap/state-11-parallel-scaffold.md"
  ".claude/patterns/change/state-2-read-context.md"
  ".claude/patterns/verify/state-2-phase1-parallel.md"
  ".claude/patterns/verify/state-3a-design-agents.md"
  ".claude/patterns/change/state-5-check-preconditions.md"
  ".claude/patterns/deploy/state-4b-production-validation.md"
  ".claude/patterns/deploy/state-3c-deploy-services.md"
  ".claude/patterns/verify.md"
  ".claude/agents/spec-reviewer.md"
  ".claude/patterns/teardown/state-2-destroy-resources.md"
  ".claude/patterns/deploy/state-0-pre-flight.md"
)

for f in "${REF_ONLY_FILES[@]}"; do
  check_present "$f" 'archetype-behavior-check\.md' \
    "should reference archetype-behavior-check.md"
done

# 5. lib-state.sh has archetype utility functions
check_present ".claude/hooks/lib-state.sh" \
  'get_archetype' \
  "missing get_archetype utility function"

echo ""
if [ "$WARNINGS" -gt 0 ]; then
  echo "WARNINGS: $WARNINGS issue(s) detected (non-blocking)."
fi
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS archetype consistency violation(s)."
  exit 1
else
  echo "PASSED: All archetype references are consistent."
fi
