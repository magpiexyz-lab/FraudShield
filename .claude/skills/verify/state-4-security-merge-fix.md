# STATE 4: SECURITY_MERGE_FIX

**PRECONDITIONS:** STATE 3c complete.

**Always write** `.runs/security-merge.json` — this is a metadata artifact, not an operational step:

- If security agents ran: merge Defender FAILs + Attacker findings (see below)
- If security agents did NOT run (scope `visual` or `build`): write `{"findings":[],"source":"no-security-agents","run_id":"<run_id>"}`
- If hard gate fired in STATE 3: write full merge + `"fixer_skipped":true,"reason":"hard_gate_failure"`

If security agents were not spawned OR hard gate failure occurred, skip security-fixer spawn and proceed to STATE 5.

**ACTIONS:**

### Merge Security Results (if scope is `full` or `security`)

Run the automated security merge script:

```bash
python3 -c "
import json, os
traces = '.runs/agent-traces'
ctx = json.load(open('.runs/verify-context.json'))
run_id = ctx.get('run_id', '')

defender = json.load(open(os.path.join(traces, 'security-defender.json')))
attacker = json.load(open(os.path.join(traces, 'security-attacker.json')))

d_fails = defender.get('fails', [])
a_findings = attacker.get('findings', [])

# Backward compat: block if structured arrays missing but counts > 0
if not d_fails and defender.get('fails_count', 0) > 0:
    raise ValueError('security-defender trace missing fails array — update agent definition')
if not a_findings and attacker.get('findings_count', 0) > 0:
    raise ValueError('security-attacker trace missing findings array — update agent definition')

# Deduplicate: same file + same desc -> keep attacker finding
# Skip findings with empty file AND empty desc to avoid false collisions
seen = set()
merged = []
for f in a_findings:
    file_val, desc_val = f.get('file',''), f.get('desc','')
    if file_val or desc_val:
        key = (file_val, desc_val)
        seen.add(key)
    merged.append({**f, 'source': 'attacker'})
for f in d_fails:
    file_val, desc_val = f.get('file',''), f.get('desc','')
    if not file_val and not desc_val:
        merged.append({**f, 'source': 'defender'})
    else:
        key = (file_val, desc_val)
        if key not in seen:
            merged.append({**f, 'source': 'defender'})

result = {
    'timestamp': __import__('datetime').datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ'),
    'defender_fails': defender.get('fails_count', 0),
    'attacker_findings': attacker.get('findings_count', 0),
    'merged_issues': len(merged),
    'issues': merged,
    'run_id': run_id
}
with open('.runs/security-merge.json', 'w') as f:
    json.dump(result, f)
print(f'Security merge: {result[\"defender_fails\"]} defender FAILs + {result[\"attacker_findings\"]} attacker findings -> {result[\"merged_issues\"]} merged issues')
"
```

### security-fixer (if merged security has issues)

Before spawning, execute the [Atomic Execution Protocol](../verify.md#atomic-execution-protocol) snapshot:

```bash
git diff --name-only > /tmp/pre-agent-snapshot.txt
```

Spawn the `security-fixer` agent (`subagent_type: security-fixer`).
Pass: merged Defender table + Attacker findings.

**Wait for the fixer to complete before continuing.**

If agent returns with Trace State 2 (exhausted), execute the [Atomic Execution Protocol](../verify.md#atomic-execution-protocol) revert before retrying (see [Exhaustion Protocol](../verify.md#exhaustion-protocol) Tier 1).

After security-fixer completes: verify `.runs/agent-traces/security-fixer.json` exists; if agent returned output but trace is missing, write a recovery trace with `"recovery":true`.

After each fix, append to `.runs/fix-log.md`.

#### Lead-side validation (security-fixer)

1. Read `.runs/agent-traces/security-fixer.json` trace.
2. If `verdict` == `"partial"` AND `unresolved_critical` > 0, this is a **hard gate failure** — Critical/High security issues or Defender FAILs remain unfixed after 2 fix cycles. Skip STATEs 5-6 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns). Report failure to user with the unresolved items.
3. If trace has `"recovery": true` AND `verdict` == `"partial"`, treat as hard gate failure (recovery traces cannot confirm fixes succeeded).
4. Extract Fix Summaries from the agent's return message. Append each fix to `.runs/fix-log.md` with the prefix `Fix (security-fixer):`.
5. If the lead directly applies additional security fixes beyond what security-fixer handled (e.g., defender findings the fixer did not address), append to `.runs/fix-log.md`:
   `Fix (lead-security): \`<file>\` — Symptom: <finding> — Fix: <what changed>`

**POSTCONDITIONS:** `security-merge.json` exists. Security-fixer trace exists (if spawned). If security-fixer verdict is `"partial"` with `unresolved_critical` > 0, pipeline is halted.

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/security-merge.json')); assert 'run_id' in d, 'run_id missing'; has_source=d.get('source')=='no-security-agents'; assert has_source or (isinstance(d.get('issues'), list) and isinstance(d.get('merged_issues'), int)), 'full-scope merge missing issues or merged_issues'"
```

> **Hook-enforced:** `skill-agent-gate.sh` validates STATE 4 postconditions before allowing observer to spawn.

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 4
```

**NEXT:** Read [state-5-e2e-tests.md](state-5-e2e-tests.md) to continue.
