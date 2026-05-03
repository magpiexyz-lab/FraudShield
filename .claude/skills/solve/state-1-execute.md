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
          # RMG v2 typed schema — see .claude/scripts/lib/recurrence_guard_parser.py.
          # None when recurrence_risk == 'none'; otherwise a dict:
          #   {"kind": "test|lint|hook|invariant|none",
          #    "artifact": "<path-or-rule-id>" | None,
          #    "rationale": "<≤200ch>",
          #    "unguardability_rationale": "<≥80ch, only when kind == 'none'>"}
          'recurrence_guard': None,
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
python3 .claude/scripts/verify-recurrence-guard.py --require-phase-3-gaps --require-run-id --skill solve  # .runs/solve-trace.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 1
```

**NEXT:** Read [state-2-output.md](state-2-output.md) to continue.
