# STATE 0: SCOPE_AND_BASELINE

**PRECONDITIONS:**
- Git repository exists in working directory

**ACTIONS:**

### Scope selection

Parse `$ARGUMENTS` for an optional focus scope:

| Argument | Scope | Files scanned |
|----------|-------|---------------|
| (empty) | full | All .claude/ subdirectories |
| `hooks` | hooks only | `.claude/hooks/*.sh` |
| `commands` | skills only | `.claude/commands/*.md` |
| `patterns` | patterns only | `.claude/patterns/**/*.md`, `.claude/procedures/*.md` |
| `agents` | agents only | `.claude/agents/*.md` |
| `stacks` | stacks only | `.claude/stacks/**/*.md` |

If `$ARGUMENTS` contains `--save`, set `save_manifest = true`.

### Baseline metrics

Run these commands and hold the results in working memory:

```bash
# File inventory by type and total lines
echo "=== File inventory ===" && \
find .claude -name '*.md' -not -path '*plans*' | wc -l && \
find .claude -name '*.sh' | wc -l && \
find scripts -name '*.py' 2>/dev/null | wc -l && \
echo "=== Total lines ===" && \
find .claude scripts -name '*.md' -o -name '*.sh' -o -name '*.py' 2>/dev/null | xargs wc -l | tail -1

# Top 25 largest files (within selected scope, or all if full)
echo "=== Largest files ===" && \
find .claude scripts -name '*.md' -o -name '*.sh' -o -name '*.py' 2>/dev/null | \
  xargs wc -l | sort -rn | head -25

# Duplication signals: inline python3 one-liners in hooks (the #1 duplication source)
echo "=== Inline python3 patterns in hooks ===" && \
grep -ch 'python3 -c' .claude/hooks/*.sh 2>/dev/null | paste -d: - <(ls .claude/hooks/*.sh) | sort -rn

# Cross-file reference frequency
echo "=== Most-referenced patterns ===" && \
grep -roh '[a-z/-]*\.md' .claude/commands/ .claude/patterns/ 2>/dev/null | \
  grep -v '^$' | sort | uniq -c | sort -rn | head -15

# Hook function definitions (shared vs local)
echo "=== Hook functions ===" && \
grep -hn '^[a-z_]*()' .claude/hooks/*.sh 2>/dev/null
```

Validator health baseline:
```bash
python3 scripts/validate-frontmatter.py 2>&1 | tail -1
python3 scripts/validate-semantics.py 2>&1 | tail -1
bash scripts/consistency-check.sh 2>&1 | tail -1
```

### Prior audit (delta tracking)

If `.claude/audit-manifest.json` exists from a prior run:
```bash
python3 -c "
import json
d = json.load(open('.claude/audit-manifest.json'))
print(f\"Prior audit: {d.get('timestamp','')} — {d.get('total_findings',0)} findings\")
for f in d.get('findings', []):
    print(f\"  [{f.get('dimension','')}] {f.get('title','')}\")
" 2>/dev/null || echo "No prior audit found"
```

Store prior findings as `prior_findings` for delta comparison in Step 2.

Clean stale epilogue artifacts and create context file to initialize state tracking:
```bash
rm -f .claude/observe-result.json
cat > .claude/audit-context.json << CTXEOF
{"skill":"audit","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"audit-$(date -u +%Y-%m-%dT%H:%M:%SZ)","completed_states":[0]}
CTXEOF
```

**POSTCONDITIONS:**
- Scope parsed (full, hooks, commands, patterns, agents, or stacks)
- `save_manifest` flag set (true/false)
- Baseline metrics collected (file inventory, largest files, duplication signals, references, functions)
- Validator health baseline collected
- Prior audit findings loaded (if any)
- `.claude/audit-context.json` exists

**VERIFY:**
```bash
test -f .claude/audit-context.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh audit 0
```

**NEXT:** Read [state-1-parallel-analysis.md](state-1-parallel-analysis.md) to continue.
