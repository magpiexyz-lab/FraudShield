# STATE 13a: BG2_GATE

**PRECONDITIONS:**
- All validations pass (STATE 13 POSTCONDITIONS met)

**ACTIONS:**

Follow gate execution procedure per `procedures/gate-execution.md`.

Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute BG2 Orchestration Gate. Verify: (1) npm run build passes; (2) scaffold output files exist (src/lib/*.ts, .runs/current-visual-brief.md, src/app/icon.tsx and src/app/opengraph-image.tsx (web-app only), archetype-specific pages/routes/commands from experiment.yaml); (3) landing page exists if surface!=none; (4) checkpoint is phase2-scaffold or later; (5) if stack.analytics present: for each event in experiment/EVENTS.yaml events map (filtered by requires and archetypes for current stack and archetype), grep for the event name in src/ -- BLOCK if any event is missing; (6) if stack.analytics present: grep src/lib/analytics*.ts for PROJECT_NAME and PROJECT_OWNER -- BLOCK if either is 'TODO'."

If gate-keeper returns BLOCK, fix missing outputs before proceeding.

Check off in `.runs/current-plan.md`: `- [x] BG2 Orchestration Gate passed`

**POSTCONDITIONS:**
- BG2 Orchestration Gate verdict is PASS

**VERIFY:**
```bash
python3 -c "
import json; d=json.load(open('.runs/gate-verdicts/bg2.json'))
assert d.get('verdict')=='PASS', 'BG2 verdict is %s' % d.get('verdict')
assert d.get('timestamp','')!='', 'timestamp empty'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 13a
```

**NEXT:** Read [state-14-wire-phase.md](state-14-wire-phase.md) to continue.
