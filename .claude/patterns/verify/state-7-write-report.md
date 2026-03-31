# STATE 7: WRITE_REPORT

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
for f in glob.glob('.claude/runs/agent-traces/*.json'):
    name = f.split('/')[-1].replace('.json','')
    d = json.load(open(f))
    verdicts[name] = d.get('verdict', 'missing')
print(json.dumps(verdicts))
" 2>/dev/null || echo "{}")
```

Write `.claude/runs/verify-report.md`:

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
> Populated when `.claude/runs/verify-history.jsonl` has a previous entry **matching the current skill**. Otherwise omit this section — except when `quality: production` is set in experiment.yaml, in which case emit a note: "Quality Delta: no prior baseline for this skill. This run establishes baseline; subsequent runs will show delta."
>
> Read `.claude/runs/verify-history.jsonl` and find the last entry where `skill` matches the current skill (from verify-context.json). If no matching entry exists, omit this section (or emit the production-mode note above).

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
> Populated when `quality: production`. Otherwise: "N/A — MVP mode".

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
> **Trace audit.** Count `.json` files in `.claude/runs/agent-traces/`. If the count
> does not match the number of entries in `agents_completed`:
> - List missing traces as `"MISSING TRACE — PROCESS VIOLATION"`
> - Set `process_violation: true` in verify-report.md frontmatter

> **This file is a hard gate.** The commit/PR step in the calling skill
> reads this file and includes its contents in the PR body. If the file
> does not exist, the PR step must run verify.md first.

6. Compute `overall_verdict`: if `hard_gate_failure` is `true` OR `process_violation` is `true` → `fail`, otherwise → `pass`. Write this into the frontmatter.

7. Extract dimension scores from agent traces (before traces are deleted in the calling skill's cleanup step). These scores feed Q-score computation:

   ```bash
   python3 -c "
   import json, glob, os, datetime

   ctx = json.load(open('.claude/runs/verify-context.json'))
   report = open('.claude/runs/verify-report.md').read()
   lines = report.split('\n')
   fm = {}
   in_fm = False
   for line in lines:
       s = line.strip()
       if s == '---':
           if in_fm: break
           in_fm = True; continue
       if in_fm and ':' in s:
           k, v = s.split(':', 1)
           fm[k.strip()] = v.strip()

   scope = ctx.get('scope', 'full')
   skill = ctx.get('skill', 'verify')
   dims = {}

   # Q_build (deterministic — from build attempts)
   dims['Q_build'] = round(1 - (int(fm.get('build_attempts', '1')) - 1) / 2, 3)

   # Extract per-agent dimension scores from traces
   for f in glob.glob('.claude/runs/agent-traces/*.json'):
       name = os.path.basename(f).replace('.json', '')
       try:
           d = json.load(open(f))
       except:
           continue

       if name == 'security-fixer' and scope in ('full', 'security'):
           merged = {}
           try: merged = json.load(open('.claude/runs/security-merge.json'))
           except: pass
           findings = merged.get('issues', [])
           if findings:
               weighted = sum(1.0 if i.get('severity','')=='Critical' else 0.5 if i.get('severity','')=='High' else 0.1 for i in findings)
           else:
               weighted = merged.get('merged_issues', 0)
           dims['Q_security'] = round(1 - min(weighted / 5, 1), 3)

       elif name == 'design-critic' and scope in ('full', 'visual'):
           dims['Q_design'] = round(d.get('min_score', 10) / 10, 3)

       elif name == 'ux-journeyer' and scope in ('full', 'visual'):
           dims['Q_ux'] = round(1 - min(d.get('unresolved_dead_ends', 0) / 3, 1), 3)

       elif name == 'behavior-verifier' and scope in ('full', 'security'):
           tp = d.get('tests_passed', 0)
           tf = d.get('tests_failed', 0)
           dims['Q_behavior'] = round(tp / max(tp + tf, 1), 3)

       elif name == 'spec-reviewer' and scope in ('full', 'security'):
           dims['Q_spec'] = 1.0 if d.get('verdict', '') == 'PASS' else 0.0

   # Gate: binary — build passes AND no hard gate failure
   gate = 0.0 if fm.get('hard_gate_failure', 'false') == 'true' else 1.0

   # R_system: 1 - mean(dimension scores) — measures auto-remediation
   active_dims = list(dims.values())
   r_system = round(1 - (sum(active_dims) / max(len(active_dims), 1)), 3)

   # R_human: (hard gate failures + exhaustions) / agents_expected — measures user intervention
   exhaustions = 0
   for f in glob.glob('.claude/runs/agent-traces/*.json'):
       try:
           if json.load(open(f)).get('recovery', False): exhaustions += 1
       except: pass
   agents_expected_str = fm.get('agents_expected', '')
   agents_expected = len([a for a in agents_expected_str.split(',') if a.strip()]) if agents_expected_str else 1
   r_human = round((int(fm.get('hard_gate_failure','false')=='true') + exhaustions) / max(agents_expected, 1), 3)

   # R combined: 0.3 * R_system + 0.7 * R_human
   r = round(0.3 * r_system + 0.7 * r_human, 3)

   # Q_skill = Gate * (1 - R)
   q_skill = round(gate * (1 - r), 3)

   entry = {
       'timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
       'run_id': ctx.get('run_id', ''),
       'skill': skill,
       'scope': scope,
       'archetype': ctx.get('archetype', ''),
       'build_attempts': int(fm.get('build_attempts', '1')),
       'fix_log_entries': int(fm.get('fix_log_entries', '0')),
       'hard_gate_failure': fm.get('hard_gate_failure', 'false') == 'true',
       'process_violation': fm.get('process_violation', 'false') == 'true',
       'overall_verdict': fm.get('overall_verdict', 'pass').strip(),
       'dimension_scores': dims,
       'gate': gate,
       'r_system': r_system,
       'r_human': r_human,
       'q_skill': q_skill,
   }

   # Write via shared script (see .claude/patterns/q-score.md Write Procedure)
   import subprocess, shlex
   subprocess.run(
       ['python3', '.claude/scripts/write-q-score.py', '--raw', json.dumps(entry)],
       capture_output=False
   )
   "
   ```

8. **Q-score observation trigger** (low-Q auto-observe):

   If `q_skill < 0.5` and `skill` is not `"verify"` (standalone verify has no skill attribution for template issues):

   File an observation to the template repo using `.claude/patterns/observe.md` **Path 3** (direct Q-score evaluation):
   - Title: `[observe] Low Q-score: <skill> Q=<q_skill>`
   - Body: skill name, Q-score breakdown (Gate, R_system, R_human, dimension_scores), timestamp
   - Follow observe.md's Redaction, Dedup, and Issue Creation procedures

   This is a direct evaluation (like Path 2), not a callback to STATE 6. Do NOT spawn the observer agent.

**POSTCONDITIONS:**
- `verify-report.md` exists with valid frontmatter
- `verify-history.jsonl` has a new entry appended (via CALL: `.claude/scripts/write-q-score.py`)
- Cross-validation: `verify-history.jsonl` last entry's `dimension_scores` consistent with disk artifacts:
  - If `Q_build > 0` → `.claude/runs/build-result.json` exists and `exit_code == 0`
  - If `Q_security > 0` → `.claude/runs/agent-traces/security-*.json` exists
  - If `Q_design > 0` → `.claude/runs/agent-traces/design-critic.json` exists

**VERIFY:**
```bash
head -1 .claude/runs/verify-report.md | grep -q '^---$' && tail -1 .claude/runs/verify-history.jsonl | python3 -c "
import json, sys, os, glob
e = json.loads(sys.stdin.read())
ds = e.get('dimension_scores', {})
assert not(ds.get('Q_build', 0) > 0) or (os.path.exists('.claude/runs/build-result.json') and json.load(open('.claude/runs/build-result.json')).get('exit_code') == 0), 'Q_build>0 but build failed'
assert not(ds.get('Q_security', 0) > 0) or glob.glob('.claude/runs/agent-traces/security-*.json'), 'Q_security>0 but no security traces'
assert not(ds.get('Q_design', 0) > 0) or os.path.exists('.claude/runs/agent-traces/design-critic.json'), 'Q_design>0 but no design-critic trace'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 7
```

**NEXT:** Read [state-8-save-patterns.md](state-8-save-patterns.md) to continue.
