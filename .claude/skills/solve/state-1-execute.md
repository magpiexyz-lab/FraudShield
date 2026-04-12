# STATE 1: EXECUTE

**PRECONDITIONS:**
- Problem statement and depth mode determined (STATE 0 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/solve-reasoning.md` using the selected depth mode.

Pass the problem statement verbatim -- do not reinterpret or narrow it.

- **Light mode**: Execute Steps 1-5 of solve-reasoning.md Light Mode directly in the lead agent. No subagents.
- **Full mode**: Execute Phases 1-6 of solve-reasoning.md Full Mode. Uses 4 Opus subagents across 6 phases (parallel research, constraint enumeration, user injection, solution design, critic loop, output).

If `solve-context.json` contains `problem_type = "defect"`, pass this to solve-reasoning
to activate the prevention dimension.

- **Write solve trace artifact** (`.runs/solve-trace.json`) using the contract from solve-reasoning.md:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.runs/solve-context.json'))
  trace = {
      'run_id': ctx['run_id'],
      'mode': '<light|full>',
      'problem_decomposition': '<problem statement and scope>',
      'constraint_enumeration': '<constraints identified>',
      'phase_3_gaps': '<Phase 3 gap questions, self-answers, and HIGH/LOW confidence tags (full mode); empty string for light mode>',
      'solution_design': '<chosen approach and rationale>',
      'self_check': '<revision pass results>',
      'output': '<recommended solution summary>'
  }
  # Add prevention_analysis only when problem_type is defect
  if ctx.get('problem_type') == 'defect':
      trace['prevention_analysis'] = {
          'problem_type': 'defect',
          'root_cause_addressed': True,
          'recurrence_risk': '<none|guarded|unguarded>',
          'recurrence_guard': '<description or null>',
          'scope': {'all_covered': True, 'instance_count': 0}
      }
  json.dump(trace, open('.runs/solve-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Solution analysis completed per solve-reasoning.md
- Output formatted per solve-reasoning.md Phase 6 (full mode) or Step 5 (light mode)
- `.runs/solve-trace.json` exists with required fields and `run_id` matching `solve-context.json`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/solve-trace.json')); assert d.get('mode') in ('light','full'), 'mode must be light or full'; required=['problem_decomposition','constraint_enumeration','solution_design','self_check','output']; missing=[k for k in required if not d.get(k)]; assert not missing, 'empty fields: %s' % missing; assert 'phase_3_gaps' in d, 'phase_3_gaps field missing'; assert d['mode']!='full' or d.get('phase_3_gaps'), 'phase_3_gaps empty in full mode'; ctx=json.load(open('.runs/solve-context.json')); assert d.get('run_id')==ctx.get('run_id'), 'run_id mismatch: trace=%s context=%s' % (d.get('run_id'), ctx.get('run_id'))"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 1
```

**NEXT:** Read [state-2-output.md](state-2-output.md) to continue.
