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

### RMG v2 Phase 1a Dossier (when `problem_type = "defect"`)

When the user invokes `/solve --defect` or `/solve --bug`, solve-reasoning
Phase 1a builds a Prior-Failure Dossier via
`.claude/scripts/lib/dossier_builder.py`. For `/solve`, derive the inputs
from the problem statement:

- `divergence_files` = file paths the lead extracts from
  `solve-context.json.problem_statement`. When the problem statement does
  not reference specific files (open-ended `/solve` queries), pass an empty
  list — the dossier still surfaces composite-identity matches via the
  recurrence-candidates artifact.
- `symptom_signature` = `canonicalize_symptom(problem_statement)` via
  `.claude/scripts/lib/symptom_canonicalizer.py`. This collapses line/col
  positions, PR/issue numbers, ISO timestamps, absolute paths, and short
  SHAs so paraphrased reports collide.

The dossier flows transparently into Phase 4b — the designer must emit a
`prior_failure_response[]` for every dossier entry citing a concrete delta
step or guard artifact absent from the prior commit (R2-A2). Empty dossier
→ Phase 4b is a no-op.

- **Write solve trace artifact** (`.runs/solve-trace.json`) using the contract from solve-reasoning.md:
  ```bash
  PAYLOAD=$(python3 -c "
  import json
  ctx = json.load(open('.runs/solve-context.json'))
  trace = {
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
      # RMG v2 Phase C: Prior-Failure Response. One entry per Phase 1a
      # dossier entry; each entry cites a concrete delta step or guard
      # artifact absent from the prior commit (R2-A2). Empty when dossier
      # was empty.
      trace['prior_failure_response'] = []
  print(json.dumps(trace))
  ")
  bash .claude/scripts/lib/write-gate-artifact.sh \
    --path .runs/solve-trace.json \
    --payload "$PAYLOAD" \
    --skill solve
  ```

- **Write solve challenge artifact** (`.runs/solve-challenge.json`) — closes
  the contract from `solve-reasoning.md` Phase 5 ("Store in the caller's
  challenge artifact: /solve: .runs/solve-challenge.json"). Counts come from
  the live solve-critic.json (round-2 if it ran) and the round-1 sidecar
  archive (`.runs/solve-critic-round1.json` per #1331). For light mode or
  full mode without critic, all counts are 0:

  ```bash
  PAYLOAD=$(python3 -c "
  import json, os
  sc_path = '.runs/agent-traces/solve-critic.json'
  critic_rounds = 0
  r1_count = 0
  r2_count = 0
  if os.path.exists(sc_path):
      try:
          sc = json.load(open(sc_path))
          critic_rounds = sc.get('round', 0)
          if critic_rounds == 2:
              # round-1 counts come from the archived sidecar
              arc_path = '.runs/solve-critic-round1.json'
              if os.path.exists(arc_path):
                  arc = json.load(open(arc_path))
                  r1_count = arc.get('type_a_count', 0)
              r2_count = sc.get('type_a_count', 0)
          elif critic_rounds == 1:
              r1_count = sc.get('type_a_count', 0)
      except Exception:
          pass
  challenge = {
      'critic_rounds': critic_rounds,
      'round_1_type_a_count': r1_count,
      # always emit; 0 when critic_rounds <= 1 — registry contract
      'round_2_type_a_count': r2_count,
      # /solve does not maintain a separate challenges[] array; counts only
      'concerns': []
  }
  print(json.dumps(challenge))
  ")
  bash .claude/scripts/lib/write-gate-artifact.sh \
    --path .runs/solve-challenge.json \
    --payload "$PAYLOAD" \
    --skill solve
  ```

**POSTCONDITIONS:**
- Solution analysis completed per solve-reasoning.md
- Output formatted per solve-reasoning.md Phase 6 (full mode) or Step 5 (light mode)
- `.runs/solve-trace.json` exists with required fields and `run_id` matching `solve-context.json`
- `.runs/solve-challenge.json` exists with `critic_rounds`, `round_1_type_a_count`, `round_2_type_a_count`, `concerns`

**VERIFY:**
```bash
python3 .claude/scripts/verify-recurrence-guard.py --require-phase-3-gaps --require-run-id --skill solve && python3 -c "import json,os; d=json.load(open('.runs/solve-challenge.json')); assert isinstance(d.get('critic_rounds'), int), 'critic_rounds missing or not int'; assert isinstance(d.get('round_1_type_a_count'), int), 'round_1_type_a_count missing or not int'; assert isinstance(d.get('round_2_type_a_count'), int), 'round_2_type_a_count missing or not int'; assert isinstance(d.get('concerns'), list), 'concerns missing or not list'; cr=d.get('critic_rounds',0); arc='.runs/solve-critic-round1.json'; assert cr!=2 or (os.path.exists(arc) and json.load(open(arc)).get('round')==1), '#1331 sidecar archive missing or wrong round'"  # .runs/solve-trace.json, .runs/solve-challenge.json, .runs/solve-critic-round1.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh solve 1
```

**NEXT:** Read [state-2-output.md](state-2-output.md) to continue.
