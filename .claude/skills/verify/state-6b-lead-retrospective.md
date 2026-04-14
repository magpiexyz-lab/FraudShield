# STATE 6b: LEAD_RETROSPECTIVE

**PRECONDITIONS:** STATE 6 complete.

**ACTIONS:**

### Hard gate skip path

Read `.runs/verify-context.json`. If `hard_gate_failure` is true (set by states 3b, 3c, or 4):
- Write minimal `.runs/retrospective-result.json`:
  ```json
  {
    "process_compliance": "skipped-hard-gate",
    "agent_instruction_compliance": [],
    "trace_fidelity": "skipped-hard-gate",
    "observations_filed": 0,
    "skipped": true
  }
  ```
- Skip to STATE TRACKING.

### Normal path

The lead agent answers 3 structured questions using its full execution context
(agent traces, fix-log, verify-context, in-memory knowledge of the run).

**Question 1: Flow Compliance**

> "Did execution strictly follow the state machine defined in skill files?
> Were any states skipped, reordered, or handled incorrectly?"

Review:
- `completed_states` in verify-context.json vs expected states in state-registry.json
- Whether any hard gate was triggered and handled correctly
- Whether scope table was followed for agent spawning

**Question 2: Agent Instruction Compliance**

> "Did each spawned agent execute its defined procedure correctly?
> If an agent produced incorrect output or required rework — was the template
> instruction wrong/incomplete/ambiguous, or did the agent simply not follow it?"

Review:
- Each agent trace in `.runs/agent-traces/*.json` — verdict, checks_performed, fixes
- Whether agent outputs were usable by downstream consumers
- Whether any agent exhausted turns or produced recovery traces
- Cross-agent interaction: did one agent's output cause issues for another?

**Question 3: Trace Fidelity**

> "Do the written traces accurately reflect actual execution, or are there
> omissions or inconsistencies?"

Review:
- Are all expected agent traces present?
- Do trace verdicts match observed behavior?
- Are fix-log entries consistent with agent trace fixes arrays?

### Evaluate findings

For each finding from Q1-Q3, apply the 3-condition test (observe.md Path 2):
- **Condition A**: Template file is the root cause (or project code was fixed but
  root cause is incorrect guidance in a template file)
- **Condition B**: NOT caused by environment issues (missing CLI, network, etc.)
- **Condition C**: NOT specific to this project ("Would another developer with a
  different experiment.yaml hit this same problem?")

### File qualifying observations

For findings passing all 3 conditions, follow observe.md's Redaction, Dedup,
and Issue Creation sections:

1. **Dedup**: `gh issue list --repo <TEMPLATE_REPO> --label observation --search "[observe] <template-file-basename>:" --state open --limit 20`
2. If existing issue found with same root cause: comment on it
3. If new: `gh issue create` with title `[observe] <file>: <symptom>` and label `observation`
4. Follow observe.md redaction rules — no project names, experiment details, or user data

### Write result

Write `.runs/retrospective-result.json`:
```json
{
  "process_compliance": "<summary or 'clean'>",
  "agent_instruction_compliance": [
    {"agent": "<name>", "compliant": true, "finding": null, "root_cause": "n-a"}
  ],
  "trace_fidelity": "<summary or 'clean'>",
  "observations_filed": 0,
  "skipped": false
}
```

The `agent_instruction_compliance` array has one entry per spawned agent:
- `compliant`: whether the agent followed its defined procedure
- `finding`: description of the issue (null if compliant)
- `root_cause`: `"template"` (instruction fault), `"agent"` (agent fault), or `"n-a"` (compliant)

**POSTCONDITIONS:**
- `.runs/retrospective-result.json` exists with valid schema
- Any template observations filed via observe.md pattern

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/retrospective-result.json')); assert 'process_compliance' in d; assert isinstance(d.get('agent_instruction_compliance'), list); assert 'trace_fidelity' in d; assert isinstance(d.get('observations_filed'), int)"
```
<!-- VERIFY is owned by state-registry.json. Do not edit directly. -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 6b
```

**NEXT:** Read [state-7a-write-report.md](state-7a-write-report.md) to continue.
