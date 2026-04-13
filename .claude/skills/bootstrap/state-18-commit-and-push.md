# STATE 18: COMMIT_AND_PUSH

**PRECONDITIONS:**
- ON-TOUCH persisted (STATE 17 POSTCONDITIONS met)
- Checkpoint is `awaiting-verify`

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table.
>
> State-specific logic below takes precedence.

Follow gate execution procedure per `procedures/gate-execution.md`.

- Stage files: `git add -A` (safe -- `.gitignore` excludes `.env.local`, `.runs/gate-verdicts/`, and sensitive patterns). Verify: `git diff --cached --name-only | grep -iE '\.env\.local|\.key$|\.pem$|credentials|\.secret$|\.token$|service-account' && echo "STOP: secrets staged" || echo "OK"`.
- **BG4 PR Gate**: Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute BG4 PR Gate. Verify: on feature branch (not main), commit message follows imperative mood convention." If gate-keeper returns BLOCK, fix blocking items before proceeding.
- Write `.runs/commit-message.txt`: `Bootstrap MVP scaffold from experiment.yaml`
- Do NOT write `pr-title.txt` or `pr-body.md` -- the PR is created later by `/verify` in bootstrap-verify mode.
### Q-score

Compute bootstrap execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/bootstrap-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
GATES_PASSED=$(ls .runs/gate-verdicts/bg*.json 2>/dev/null | wc -l | tr -d ' ')
Q_GATES=$(python3 -c "print(round(int('${GATES_PASSED}') / max(4, 1), 3))")
python3 -c "
import json, datetime
with open('.runs/q-dimensions.json', 'w') as f:
    json.dump({
        'skill': 'bootstrap',
        'scope': 'bootstrap',
        'dims': {'gates': float('$Q_GATES'), 'completion': 1.0},
        'run_id': '$RUN_ID' or 'bootstrap-unknown',
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }, f, indent=2)
print('Wrote .runs/q-dimensions.json')
" || true
```

- Delete `.runs/current-visual-brief.md` (keep `.runs/current-plan.md` -- `/verify` needs it)
- Tell the user: "Bootstrap ready. Run `/verify` to run verification and create the PR." If archetype is `cli` and surface is not `none`, add: "After merging, run `/deploy` for the marketing surface, then `npm publish` for the CLI binary. To verify the publish: run `npm info <package-name>` (where `<package-name>` is the `name` field from experiment.yaml) to confirm the version is live. If `npm publish` fails, check `npm whoami` — if not logged in, run `npm login` first. After publishing and collecting usage data, run `/iterate` to review metrics, or `/retro` when ready to wrap up." If archetype is `cli` and surface is `none`, add: "After merging, run `npm publish` for the CLI binary (no surface to deploy). To verify the publish: run `npm info <package-name>` (where `<package-name>` is the `name` field from experiment.yaml) to confirm the version is live. If `npm publish` fails, check `npm whoami` — if not logged in, run `npm login` first. After publishing and collecting usage data, run `/iterate` to review metrics, or `/retro` when ready to wrap up."

Check off in `.runs/current-plan.md`: `- [x] BG4 PR Gate passed`

**POSTCONDITIONS:**
- All files staged (`git add -A` complete)
- BG4 PR Gate verdict is PASS
- `.runs/commit-message.txt` written (no `pr-title.txt` or `pr-body.md`)
- `.runs/q-dimensions.json` written
- `.runs/current-visual-brief.md` deleted

**VERIFY:**
```bash
python3 -c "import json,os; g=json.load(open('.runs/gate-verdicts/bg4.json')); assert g.get('verdict')=='PASS', 'BG4 verdict is %s' % g.get('verdict'); assert os.path.isfile('.runs/commit-message.txt'), 'commit-message.txt missing'; json.load(open('.runs/q-dimensions.json'))"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 18
```

**NEXT:** TERMINAL -- `lifecycle-finalize.sh` handles commit and push (no PR). Run `/verify` next to create the PR.
