#!/usr/bin/env bash
set -euo pipefail

# check-archetype-consistency.sh — Verify archetype branching references are
# standardized across all files that contain archetype-conditional logic.
#
# Canonical source: .claude/patterns/archetype-behavior-check.md (Quick-Reference Table)
# All archetype-branching files use REF-only references to the canonical source

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

# 3. All archetype-branching files reference archetype-behavior-check.md
REF_ONLY_FILES=(
  ".claude/procedures/wire.md"
  ".claude/procedures/change-plans.md"
  ".claude/procedures/change-feature.md"
  ".claude/procedures/behavior-verifier.md"
  ".claude/procedures/scaffold-pages.md"
  ".claude/procedures/change-test.md"
  ".claude/procedures/accessibility-scanner.md"
  ".claude/procedures/plan-validation.md"
  ".claude/procedures/scaffold-libs.md"
  ".claude/procedures/scaffold-landing.md"
  ".claude/agents/gate-keeper.md"
  ".claude/agents/behavior-verifier.md"
  ".claude/agents/performance-reporter.md"
  ".claude/agents/security-defender.md"
  ".claude/agents/provision-scanner.md"
  ".claude/agents/spec-reviewer.md"
  ".claude/hooks/skill-agent-gate.sh"
  ".claude/stacks/framework/nextjs.md"
  ".claude/patterns/security-review.md"
  ".claude/patterns/verify.md"
  ".claude/skills/audit/state-1-parallel-analysis.md"
  ".claude/skills/bootstrap/state-9-setup-phase.md"
  ".claude/skills/bootstrap/state-11-parallel-scaffold.md"
  ".claude/skills/bootstrap/state-13-merged-validation.md"
  ".claude/skills/bootstrap/state-13a-analytics-design-check.md"
  ".claude/skills/bootstrap/state-13b-content-seo-check.md"
  ".claude/skills/bootstrap/state-13c-bg2-gate.md"
  ".claude/skills/bootstrap/state-14-wire-phase.md"
  ".claude/skills/bootstrap/state-18-commit-and-push.md"
  ".claude/skills/change/state-2-read-context.md"
  ".claude/skills/change/state-5-check-preconditions.md"
  ".claude/skills/change/state-9-update-specs.md"
  ".claude/skills/change/state-10-implement.md"
  ".claude/skills/change/state-11-verify.md"
  ".claude/skills/change/state-12-commit-and-pr.md"
  ".claude/skills/deploy/state-0-pre-flight.md"
  ".claude/skills/deploy/state-3c-deploy-services.md"
  ".claude/skills/deploy/state-4a-health-fix.md"
  ".claude/skills/deploy/state-4b-production-validation.md"
  ".claude/skills/iterate/state-0-read-context.md"
  ".claude/skills/iterate/state-4-output.md"
  ".claude/skills/retro/state-3-file-issue.md"
  ".claude/skills/spec/state-4-golden-path.md"
  ".claude/skills/spec/state-6-stack-funnel.md"
  ".claude/skills/teardown/state-0-pre-flight.md"
  ".claude/skills/teardown/state-2-destroy-resources.md"
  ".claude/skills/verify/state-2-phase1-parallel.md"
  ".claude/skills/verify/state-3a-design-agents.md"
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
