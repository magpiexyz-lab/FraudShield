# STATE 7a: WRITE_REPORT

**PRECONDITIONS:** STATE 6 complete. All agents finished. All traces written.

> **This state is gated by `verify-report-gate.sh`.** The hook checks that
> verify-context.json, fix-log.md, and agent traces exist before allowing
> the write. If the hook denies the write, go back and complete the missing steps.

**ACTIONS:**

Before writing the report, extract agent verdicts from traces:

```bash
AGENT_VERDICTS=$(python3 -c "
import json, glob
verdicts = {}
for f in glob.glob('.runs/agent-traces/*.json'):
    name = f.split('/')[-1].replace('.json','')
    d = json.load(open(f))
    verdicts[name] = d.get('verdict', 'missing')
print(json.dumps(verdicts))
" 2>/dev/null || echo "{}")
```

Write `.runs/verify-report.md`:

```markdown
---
timestamp: [ISO 8601]
scope: [full|security|visual|build]
build_attempts: [1-3]
fix_log_entries: [N]
agents_expected: [list from scope table]
agents_completed: [list as they finish]
consistency_scan: pass | skipped | N/A
auto_observe: ran | skipped-no-fixes | observations-filed
agent_verdicts: <AGENT_VERDICTS JSON>
hard_gate_failure: false
process_violation: false
overall_verdict: pass | fail
---

## Build
- Attempts: [N]/3
- Result: pass
- Last output: [last 3-5 lines of build output]

## Quality Delta
> Populated when `.runs/verify-history.jsonl` has a previous entry **matching the current skill**. Otherwise emit a note: "Quality Delta: no prior baseline for this skill. This run establishes baseline; subsequent runs will show delta."
>
> Read `.runs/verify-history.jsonl` and find the last entry where `skill` matches the current skill (from verify-context.json). If no matching entry exists, emit the note above.

| Metric | Previous | Current | Delta |
|--------|----------|---------|-------|
| Build attempts | [prev] | [curr] | [+/-N or —] |
| Fix log entries | [prev] | [curr] | [+/-N or —] |
| Overall verdict | [prev] | [curr] | [improved/regressed/—] |
| Q-score | [prev] | [curr] | [+/-N or —] |

## Review Agents
| Agent | Verdict | Notes |
|-------|---------|-------|
| design-critic | [pass/fixed/skipped] | [1-line summary] |
| design-critic-shared | [fixed/skipped/N/A] | [shared component fixes, or "no shared issues"] |
| ux-journeyer | [pass/fixed/skipped] | [1-line summary] |
| security-defender | [pass/N issues] | [1-line summary] |
| security-attacker | [pass/N findings] | [1-line summary] |
| security-fixer | [fixed N/skipped] | [1-line summary] |
| behavior-verifier | [pass/N issues] | [1-line summary] |
| performance-reporter | [summary/skipped] | [1-line summary] |
| accessibility-scanner | [pass/N issues/skipped] | [1-line summary] |
| spec-reviewer | [pass/N gaps/skipped] | [1-line summary] |

## Observations Filed
- [list, or "None"]

## Process Compliance
> Always populated.

- Process Checklist in current-plan.md: [present | missing]
- TDD order: [pass | WARN — N violations | N/A]
- Source: spec-reviewer S8
```

Only include agents that were spawned (per scope). Mark others as "skipped — out of scope".

> **Default fields:** The `hard_gate_failure: false` and `process_violation: false` fields are always present in the template. Set them to `true` when the relevant conditions are triggered (see below). The verify-report-gate hook validates their presence unconditionally.

> **Completion audit.** Before writing verify-report.md, compare
> `agents_expected` (from scope table) against `agents_completed`.
> If any expected agent was not spawned:
> - List it as `"SKIPPED — PROCESS VIOLATION"` (not `"skipped — out of scope"`)
> - Set `process_violation: true` in verify-report.md frontmatter
> - BG3 gate will BLOCK on process violations
>

> **This file is a hard gate.** The commit/PR step in the calling skill
> reads this file and includes its contents in the PR body. If the file
> does not exist, the PR step must run verify.md first.

6. **Config-error gate:** Before computing the verdict, check if E2E tests were skipped due to config errors:

   ```bash
   if test -f .runs/e2e-result.json && python3 -c "import json; exit(0 if json.load(open('.runs/e2e-result.json')).get('config_error') else 1)" 2>/dev/null; then
     python3 -c "
   import re
   with open('.runs/verify-report.md', 'r') as f:
       content = f.read()
   content = re.sub(r'^hard_gate_failure: false$', 'hard_gate_failure: true', content, flags=re.MULTILINE)
   with open('.runs/verify-report.md', 'w') as f:
       f.write(content)
   "
     echo "Config-error gate: set hard_gate_failure=true (tests never executed)"
   fi
   ```

7. Compute `overall_verdict`: if `hard_gate_failure` is `true` OR `process_violation` is `true` → `fail`, otherwise → `pass`. Write this into the frontmatter.

**POSTCONDITIONS:**
- `verify-report.md` exists with valid frontmatter (starts with `---`)
- `overall_verdict` field is present in frontmatter
- `agents_expected` and `agents_completed` fields are present
- `hard_gate_failure` and `process_violation` fields are present

**VERIFY:**
```bash
head -1 .runs/verify-report.md | grep -q '^---$' && python3 -c "c=open('.runs/verify-report.md').read(); fm=c.split('---')[1] if c.count('---')>=2 else ''; missing=[f for f in ['overall_verdict:','hard_gate_failure:','process_violation:','agents_expected:','agents_completed:'] if f not in fm]; assert not missing, 'verify-report frontmatter missing: %s' % missing"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 7a
```

**NEXT:** Read [state-7b-compute-qscore.md](state-7b-compute-qscore.md) to continue.
