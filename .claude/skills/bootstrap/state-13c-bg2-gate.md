# STATE 13c: BG2_GATE

**PRECONDITIONS:**
- Content and SEO checks pass (STATE 13b POSTCONDITIONS met)

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

Follow gate execution procedure per `procedures/gate-execution.md`.

Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute BG2 Orchestration Gate. Verify: (1) .runs/bootstrap-build-result.json exists and exit_code == 0; (2) scaffold output files exist (src/lib/*.ts, .runs/current-visual-brief.md, src/app/icon.tsx and src/app/opengraph-image.tsx (web-app only), archetype-specific pages/routes/commands from experiment.yaml); (3) landing page exists if surface!=none; (4) checkpoint is phase2-scaffold or later; (5) if stack.analytics present: for each event in experiment/EVENTS.yaml events map (filtered by requires and archetypes for current stack and archetype), grep for the event name in src/ -- BLOCK if any event is missing; (6) if stack.analytics present: grep src/lib/analytics*.ts for PROJECT_NAME and PROJECT_OWNER -- BLOCK if either is 'TODO'."

> **Note:** Analytics checks (5) and (6) overlap with STATE 13a step 3. This is intentional
> defense-in-depth — gate-keeper is an independent agent that re-validates from scratch,
> catching regressions introduced by fixes in states 13a-13b.

If gate-keeper returns BLOCK, fix missing outputs before proceeding.

Check off in `.runs/current-plan.md`: `- [x] BG2 Orchestration Gate passed`

**POSTCONDITIONS:**
- BG2 Orchestration Gate verdict is PASS

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/gate-verdicts/bg2.json')); assert d.get('verdict')=='PASS', 'BG2 verdict is %s' % d.get('verdict'); assert d.get('timestamp','')!='', 'timestamp empty'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 13c
```

**NEXT:** Read [state-14-wire-phase.md](state-14-wire-phase.md) to continue.
