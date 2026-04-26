#!/usr/bin/env bash
set -euo pipefail

# consistency-check.sh — Verify facts live in canonical sources, not in rules/skills
#
# Canonical (facts SHOULD appear here):
#   experiment/EVENTS.yaml, .claude/stacks/**/*.md, experiment/experiment.yaml
#
# Reference-only (facts should NOT appear here):
#   CLAUDE.md, .claude/commands/*.md

ERRORS=0
WARNINGS=0

# Derive code-writing skills dynamically from frontmatter type
CODE_WRITING_SKILLS=()
for f in .claude/commands/*.md; do
  [ -f "$f" ] || continue
  if head -20 "$f" | grep -q 'type: code-writing'; then
    CODE_WRITING_SKILLS+=("$f")
  fi
done

check_absent() {
  local file="$1" pattern="$2" desc="$3"
  [ -f "$file" ] || return 0
  if grep -qE "$pattern" "$file"; then
    echo "FAIL: $file — $desc"
    grep -nE "$pattern" "$file" | head -5
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
}

echo "=== Consistency Check: Reference, Never Restate ==="
echo ""

# 1. Event name enumerations in CLAUDE.md (bullet + backtick-event + dash)
check_absent "CLAUDE.md" \
  '^\s*-\s*`(visit_landing|signup_start|signup_complete|activate|retain_return|pay_start|pay_success)` — ' \
  "enumerated event definitions (should reference experiment/EVENTS.yaml)"

# 2. Event name enumerations in skill files
for f in .claude/commands/*.md; do
  [ -f "$f" ] || continue
  check_absent "$f" \
    '^\s*[\-\|]\s*`?(visit_landing|signup_start|signup_complete|activate|retain_return|pay_start|pay_success)`?\s*(on |— |\| [a-z])' \
    "enumerated event names (should reference experiment/EVENTS.yaml)"
done

# 3. Hardcoded analytics import path in skills, agents, and procedures
for f in .claude/commands/*.md .claude/agents/*.md .claude/procedures/*.md; do
  [ -f "$f" ] || continue
  check_absent "$f" '@/lib/analytics' \
    "hardcoded import path (should reference analytics stack file)"
done

# 4. Framework-specific terms in CLAUDE.md
check_absent "CLAUDE.md" \
  'Server Actions|parallel routes|intercepting routes' \
  "framework-specific terms (belong in framework stack file)"

# 5. Framework-specific terms in skill files
for f in .claude/commands/*.md; do
  [ -f "$f" ] || continue
  check_absent "$f" '"use client"' \
    "Next.js directive (should reference framework stack file)"
  check_absent "$f" 'Server Actions' \
    "Next.js term (should reference framework stack file)"
  check_absent "$f" '\buseEffect\b' \
    "React-specific term (use generic or reference framework stack file)"
done

# 6. Hardcoded analytics constants in CLAUDE.md
check_absent "CLAUDE.md" 'PROJECT_NAME|PROJECT_OWNER' \
  "hardcoded constant names (should reference analytics stack file)"

# 7. Hardcoded framework paths in feature skill
check_absent ".claude/commands/change.md" 'src/app/api/' \
  "hardcoded API path (should reference framework stack file)"
check_absent ".claude/commands/change.md" 'src/lib/types\.ts' \
  "hardcoded types path (should reference database stack file)"

# 8. (removed)

# 9. Hardcoded analytics path in PR template
check_absent ".github/PULL_REQUEST_TEMPLATE.md" 'src/lib/analytics' \
  "hardcoded analytics path (should say 'the analytics library')"

# 10. All code-writing skills reference verify.md
for f in "${CODE_WRITING_SKILLS[@]}"; do
  [ -f "$f" ] || continue
  if ! grep -q 'patterns/verify.md' "$f"; then
    echo "FAIL: $f — missing verify.md reference (all code-writing skills must reference the verification procedure)"
    ERRORS=$((ERRORS + 1))
  fi
done

# 11. (removed)

# 12. (removed)

# 13. Hardcoded analytics provider names in skill, agent, and procedure section headings
# (Check numbers 14-15 added below)

for f in .claude/commands/*.md .claude/agents/*.md .claude/procedures/*.md; do
  [ -f "$f" ] || continue
  if grep -qiE '^###.*PostHog' "$f"; then
    echo "FAIL: $f — hardcoded analytics provider name in section heading (should be provider-agnostic)"
    grep -niE '^###.*PostHog' "$f" | head -5
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
done

# 14. Verify lib.sh function calls have space before arguments in hook scripts
LIB_FUNCS="compute_missing_states|require_trace_verdict|check_trace_run_id|check_trace_verdict|check_postcondition_artifacts|check_tier1_retry_complete|check_efficiency_directives|check_build_result|check_file_boundary|check_verdict_gates|check_skill_completion|check_block_verdicts|check_verdict_consistency|check_verdict_error|check_fixlog_verdict_consistency|rerun_postconditions|require_trace_verdict|handle_validation|deny_errors|exec_merge_gate|run_merge_gate"
for f in .claude/hooks/*.sh; do
  [ -f "$f" ] || continue
  [[ "$(basename "$f")" =~ ^lib(-[a-z-]+)?\.sh$ ]] && continue
  if grep -qE "($LIB_FUNCS)\"" "$f"; then
    echo "FAIL: $f — function call missing space before argument (concatenates function name with argument)"
    grep -nE "($LIB_FUNCS)\"" "$f" | head -5
    echo ""
    ERRORS=$((ERRORS + 1))
  fi
done

# 15. Verify STATE_ID regex character class matches between state-completion-gate and phase-boundary-gate
SCG=".claude/hooks/state-completion-gate.sh"
PBG=".claude/hooks/phase-boundary-gate.sh"
if [ -f "$SCG" ] && [ -f "$PBG" ]; then
  SCG_CLASS=$(grep -oE 'advance-state.*\[0-9a-z[_]*\]' "$SCG" | head -1 | grep -oE '\[0-9a-z[_]*\]' || echo "")
  PBG_CLASS=$(grep -oE 'advance-state.*\[0-9a-z[_]*\]' "$PBG" | head -1 | grep -oE '\[0-9a-z[_]*\]' || echo "")
  if [ -n "$SCG_CLASS" ] && [ -n "$PBG_CLASS" ] && [ "$SCG_CLASS" != "$PBG_CLASS" ]; then
    echo "FAIL: STATE_ID regex mismatch — state-completion-gate.sh uses $SCG_CLASS, phase-boundary-gate.sh uses $PBG_CLASS"
    ERRORS=$((ERRORS + 1))
  fi
fi

# 16. Verify verify.md STATE 5 branches on testing framework type
STATE5=".claude/skills/verify/state-5-e2e-tests.md"
if [ -f "$STATE5" ]; then
  if grep -q 'playwright' "$STATE5" && ! grep -q 'vitest' "$STATE5"; then
    echo "FAIL: $STATE5 — hardcodes playwright without vitest branch (must handle all testing frameworks)"
    ERRORS=$((ERRORS + 1))
  fi
  if grep -q 'vitest' "$STATE5" && ! grep -q 'playwright' "$STATE5"; then
    echo "FAIL: $STATE5 — hardcodes vitest without playwright branch (must handle all testing frameworks)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# 17. Non-STATE-0 registry entries should use content validation, not just test -f
REGISTRY=".claude/patterns/state-registry.json"
if [ -f "$REGISTRY" ]; then
  WEAK=$(python3 -c "
import json, sys
data = json.load(open('$REGISTRY'))
skip = {'trace_schemas'}
s0 = {'0', 'c0', 'x0'}
weak = []
for skill, states in data.items():
    if skill in skip or not isinstance(states, dict): continue
    for sid, pc in states.items():
        if sid in s0: continue
        if isinstance(pc, str) and pc.startswith('test -f ') and 'python3' not in pc and 'grep' not in pc:
            weak.append(f'{skill}[{sid}]')
for w in weak:
    print(w)
" 2>/dev/null)
  if [ -n "$WEAK" ]; then
    echo "WARN: state-registry.json — non-STATE-0 entries use file-existence-only postconditions (consider content validation):"
    echo "$WEAK" | sed 's/^/  /'
    echo ""
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# --- Check 18: Verify gate-keeper spawn prompts include Verify criteria ---
echo -n "Check 18: gate-keeper prompts include Verify criteria... "
GATE_MISSING=0
for f in .claude/skills/bootstrap/state-*.md .claude/skills/*/state-*.md; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    if echo "$line" | grep -qi 'gate-keeper.*Pass:' && ! echo "$line" | grep -qi 'Verify:'; then
      echo ""
      echo "  WARN: $f: gate-keeper prompt missing 'Verify:' criteria"
      echo "    $line"
      GATE_MISSING=$((GATE_MISSING + 1))
    fi
  done < "$f"
done
if [ "$GATE_MISSING" -gt 0 ]; then
  echo ""
  echo "  $GATE_MISSING gate-keeper prompt(s) missing Verify criteria (non-blocking)."
  WARNINGS=$((WARNINGS + GATE_MISSING))
else
  echo "ok"
fi

# 19. Non-STATE-0 VERIFY commands must include content assertions, not just isinstance/type checks
echo -n "Check 19: VERIFY commands include content assertions... "
if [ -f "$REGISTRY" ]; then
  WEAK_TYPE=$(python3 -c "
import json, re, sys
data = json.load(open('$REGISTRY'))
skip = {'trace_schemas'}
s0 = {'0', 'c0', 'x0'}
content_patterns = [
    r'len\(', r'>=', r'<=', r'>\s*0', r'==\s', r'!=',
    r'is True', r'is False', r'is not None',
    r'\ball\(', r'\bany\(', r'\bnot in\b', r'\bin [a-z\[\(]',
    r'\.get\([^)]+\)\s*[><=!]'
]
weak = []
for skill, states in data.items():
    if skill in skip or not isinstance(states, dict): continue
    for sid, pc in states.items():
        if sid in s0: continue
        verify_cmd = pc
        if isinstance(pc, dict):
            verify_cmd = pc.get('verify', '')
        if not isinstance(verify_cmd, str): continue
        if 'isinstance(' not in verify_cmd: continue
        if verify_cmd == 'true': continue
        has_content = any(re.search(p, verify_cmd) for p in content_patterns)
        if not has_content:
            weak.append(f'{skill}[{sid}]')
for w in weak:
    print(w)
" 2>/dev/null)
  if [ -n "$WEAK_TYPE" ]; then
    echo ""
    echo "  FAIL: state-registry.json — VERIFY commands use isinstance() without content assertions:"
    echo "$WEAK_TYPE" | sed 's/^/    /'
    echo "  Add content checks (len()>0, >=0, is True, all(), etc.) alongside isinstance() checks."
    ERRORS=$((ERRORS + 1))
  else
    echo "ok"
  fi
else
  echo "skip (no registry)"
fi

# 20. Makefile lint-template target must cover every template validator CI runs.
# Rationale (issue #1003): auto-merge Guard 3 delegates to `make lint-template`
# as a local mirror of CI. If CI gains a new validator without a matching
# Makefile edit, the local mirror drifts and auto-merge lets CI-red PRs land.
# Validators that cannot meaningfully run outside CI (require PR SHAs, scheduled
# nightly, etc.) are declared in a `# CI-ONLY:` comment directly above the
# Makefile `lint-template:` target and skipped from the parity assertion.
echo -n "Check 20: Makefile lint-template ↔ CI validators parity... "
PARITY_ERR=""
PARITY_RC=0
# Wrap command-substitution in `if` so `set -e` treats a non-zero Python exit
# as ordinary control flow, not a fatal error that terminates the script.
if PARITY_ERR=$(python3 - <<'PY' 2>&1
import re, pathlib, sys
VAL_RE = re.compile(r'(python3\s+-m\s+pytest\s+scripts/|python3\s+scripts/[A-Za-z0-9_-]+\.py|bash\s+scripts/[A-Za-z0-9_-]+\.sh|bash\s+\.claude/scripts/[A-Za-z0-9_-]+\.sh)')
def extract(text):
    return {re.sub(r'\s+', ' ', m.group(1)).strip() for m in VAL_RE.finditer(text)}
ci = set()
wf_dir = pathlib.Path('.github/workflows')
if wf_dir.is_dir():
    for p in sorted(wf_dir.glob('*.yml')):
        ci |= extract(p.read_text())
mk_path = pathlib.Path('Makefile')
mk = set()
ci_only = set()
if mk_path.is_file():
    mk_text = mk_path.read_text()
    # Union the body of every target whose name starts with `lint-template`
    # (lint-template, lint-template-tests, lint-template-full). Splitting the
    # local mirror into fast + heavy targets is legitimate — Check 20 treats
    # the lint-template* family as a single allowed set.
    for m in re.finditer(r'^(lint-template[A-Za-z0-9_-]*):.*?(?=^[A-Za-z_][A-Za-z0-9_-]*:|\Z)', mk_text, re.M | re.S):
        mk |= extract(m.group(0))
    lines = mk_text.splitlines()
    for i, line in enumerate(lines):
        # Find the CI-ONLY comment above the first lint-template* target
        if re.match(r'^lint-template[A-Za-z0-9_-]*:', line) and i > 0:
            for j in range(i - 1, -1, -1):
                s = lines[j].strip()
                if not s.startswith('#'): break
                if s.startswith('# CI-ONLY:'):
                    for v in s.split(':', 1)[1].split(','):
                        v = v.strip()
                        if v: ci_only.add(re.sub(r'\s+', ' ', v))
            break
missing = ci - mk - ci_only
extra = ci_only - ci
if missing or extra:
    if missing:
        print('MISSING: ' + '; '.join(sorted(missing)))
    if extra:
        print('STALE-CI-ONLY: ' + '; '.join(sorted(extra)))
    sys.exit(1)
PY
); then
  PARITY_RC=0
else
  PARITY_RC=1
fi
if [ "$PARITY_RC" -ne 0 ]; then
  echo ""
  echo "  FAIL: Makefile lint-template drifted from CI validators:"
  echo "$PARITY_ERR" | sed 's/^/    /'
  echo "  Add missing validators to Makefile lint-template target, or declare them in a '# CI-ONLY:' comment."
  ERRORS=$((ERRORS + 1))
else
  echo "ok"
fi

# 21. No `gh pr merge --auto` anywhere under .claude/. Repo allow_auto_merge=false
# makes --auto silently fire an immediate non-gated merge — see issue #1003 and
# feedback_gh_pr_merge_auto_fallback memory. Lines with a DO_NOT comment marker
# are skipped so auto-merge.md can document "do not use this" without tripping.
# .claude/worktrees/ (transient, gitignored) is excluded.
echo -n "Check 21: No gh pr merge --auto under .claude/... "
AUTO_HITS=$(
  grep -rnE 'pr merge[^\n]*--auto' \
    --include='*.sh' --include='*.md' \
    --exclude-dir=worktrees \
    .claude/scripts/ .claude/patterns/ .claude/hooks/ 2>/dev/null \
    | grep -vE '\bDO_NOT\b' \
    || true
)
if [ -n "$AUTO_HITS" ]; then
  echo ""
  echo "  FAIL: forbidden --auto flag (repo allow_auto_merge=false — silent immediate-merge):"
  echo "$AUTO_HITS" | sed 's/^/    /'
  ERRORS=$((ERRORS + 1))
else
  echo "ok"
fi

# 22. gh pr merge callers restricted to an explicit allowlist.
# Prevents a future script from adding a merge call that bypasses the Guard chain
# in lifecycle-finalize.sh. DO_NOT-marked lines are skipped (doc mentions).
# .claude/worktrees/ (transient, gitignored) is excluded.
echo -n "Check 22: gh pr merge callers restricted to allowlist... "
MERGE_HITS=$(
  grep -rnE 'gh pr merge\b' \
    --include='*.sh' --include='*.md' \
    --exclude-dir=worktrees \
    .claude/ 2>/dev/null \
    | grep -vE '\bDO_NOT\b' \
    || true
)
VIOLATIONS=$(
  echo "$MERGE_HITS" \
    | grep -vE '^\.claude/scripts/lifecycle-finalize\.sh:|^\.claude/patterns/auto-merge\.md:' \
    | grep -v '^$' \
    || true
)
if [ -n "$VIOLATIONS" ]; then
  echo ""
  echo "  FAIL: gh pr merge called outside allowlist (lifecycle-finalize.sh, auto-merge.md):"
  echo "$VIOLATIONS" | sed 's/^/    /'
  ERRORS=$((ERRORS + 1))
else
  echo "ok"
fi

echo ""
if [ "$WARNINGS" -gt 0 ]; then
  echo "WARNINGS: $WARNINGS weak postcondition(s) detected (non-blocking)."
fi
if [ "$ERRORS" -gt 0 ]; then
  echo "FAILED: $ERRORS violation(s). Move facts to canonical sources (experiment/EVENTS.yaml, stack files)."
  exit 1
else
  echo "PASSED: No consistency violations."
fi
