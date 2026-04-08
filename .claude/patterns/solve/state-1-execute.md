# STATE 1: EXECUTE

**PRECONDITIONS:**
- Problem statement and depth mode determined (STATE 0 POSTCONDITIONS met)

**ACTIONS:**

Follow `.claude/patterns/solve-reasoning.md` using the selected depth mode.

Pass the problem statement verbatim -- do not reinterpret or narrow it.

- **Light mode**: Execute Steps 1-5 of solve-reasoning.md Light Mode directly in the lead agent. No subagents.
- **Full mode**: Execute Phases 1-6 of solve-reasoning.md Full Mode. Uses 4 Opus subagents across 6 phases (parallel research, constraint enumeration, user injection, solution design, critic loop, output).

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
      'solution_design': '<chosen approach and rationale>',
      'self_check': '<revision pass results>',
      'output': '<recommended solution summary>'
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
python3 -c "
import json
d = json.load(open('.runs/solve-trace.json'))
ctx = json.load(open('.runs/solve-context.json'))
assert d.get('run_id') == ctx.get('run_id'), 'run_id mismatch'
assert d.get('mode') in ('light', 'full'), 'invalid mode'
" && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 1
```

**NEXT:** Read [state-2-output.md](state-2-output.md) to continue.
