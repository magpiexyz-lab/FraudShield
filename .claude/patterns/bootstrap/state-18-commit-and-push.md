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
- Commit: "Bootstrap MVP scaffold from experiment.yaml"
- **BG4 PR Gate**: Spawn the `gate-keeper` agent (`subagent_type: gate-keeper`). Pass: "Execute BG4 PR Gate. Verify: on feature branch (not main), git status shows no uncommitted changes to tracked files, commit message follows imperative mood." If gate-keeper returns BLOCK, fix blocking items before pushing.
- Push to the remote branch
### Q-score

Compute bootstrap execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/bootstrap-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
GATES_PASSED=$(ls .runs/gate-verdicts/bg*.json 2>/dev/null | wc -l | tr -d ' ')
Q_GATES=$(python3 -c "print(round(int('${GATES_PASSED}') / max(4, 1), 3))")
python3 .claude/scripts/write-q-score.py \
  --skill bootstrap --scope bootstrap \
  --archetype "$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('type','web-app'))" 2>/dev/null || echo web-app)" \
  --gate 1.0 --dims "{\"gates\": $Q_GATES, \"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

### Observation (defense in depth)

Idempotency guard: if `.runs/observe-result.json` already exists, skip this section.

Write evidence check artifact (proves the scan ran):
```bash
python3 -c "
import json, os, glob, datetime
fix_log_lines = 0
if os.path.exists('.runs/fix-log.md'):
    with open('.runs/fix-log.md') as f:
        fix_log_lines = max(0, len(f.readlines()) - 1)
trace_fixes = 0
for tf in glob.glob('.runs/agent-traces/*.json'):
    try:
        data = json.load(open(tf))
        if isinstance(data.get('fixes'), list) and len(data['fixes']) > 0:
            trace_fixes += 1
    except: pass
json.dump({
    'fix_log_entries': fix_log_lines,
    'trace_fixes_found': trace_fixes,
    'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat()
}, open('.runs/observe-evidence-check.json', 'w'), indent=2)
"
```

Check if observation evidence exists:
1. `.runs/fix-log.md` has entries beyond the header (more than 2 lines), OR
2. Any `.runs/agent-traces/*.json` file has a non-empty `fixes` array

If evidence exists:
1. Collect template diffs: `git diff HEAD~1..HEAD -- .claude/ > .runs/observer-diffs.txt`
2. Follow `.claude/patterns/skill-epilogue.md` Strategy A (spawn observer with collected diffs)

If no evidence, write `.runs/observe-result.json`:
```json
{
  "skill": "bootstrap",
  "timestamp": "<ISO 8601>",
  "friction_detected": false,
  "observations_filed": 0,
  "verdict": "clean"
}
```

If observer spawning fails: write observe-result.json with `"verdict": "clean"` and continue (best-effort).

- Delete `.runs/current-visual-brief.md` (keep `.runs/current-plan.md` -- `/verify` needs it)
- Tell the user: "Bootstrap pushed. Run `/verify` to run verification and create the PR." If archetype is `cli` and surface is not `none`, add: "After merging, run `/deploy` for the marketing surface, then `npm publish` for the CLI binary. To verify the publish: run `npm info <package-name>` (where `<package-name>` is the `name` field from experiment.yaml) to confirm the version is live. If `npm publish` fails, check `npm whoami` — if not logged in, run `npm login` first. After publishing and collecting usage data, run `/iterate` to review metrics, or `/retro` when ready to wrap up." If archetype is `cli` and surface is `none`, add: "After merging, run `npm publish` for the CLI binary (no surface to deploy). To verify the publish: run `npm info <package-name>` (where `<package-name>` is the `name` field from experiment.yaml) to confirm the version is live. If `npm publish` fails, check `npm whoami` — if not logged in, run `npm login` first. After publishing and collecting usage data, run `/iterate` to review metrics, or `/retro` when ready to wrap up."

Check off in `.runs/current-plan.md`: `- [x] BG4 PR Gate passed`

**POSTCONDITIONS:**
- All files committed (no uncommitted tracked changes)
- BG4 PR Gate verdict is PASS
- Branch pushed to remote
- `.runs/observe-result.json` exists
- `.runs/current-visual-brief.md` deleted

**VERIFY:**
```bash
python3 -c "import json; g=json.load(open('.runs/gate-verdicts/bg4.json')); assert g.get('verdict')=='PASS', 'BG4 verdict is %s' % g.get('verdict'); e=json.load(open('.runs/observe-evidence-check.json')); assert e.get('checked_at','')!='', 'evidence check not performed'; d=json.load(open('.runs/observe-result.json')); assert d.get('skill')=='bootstrap', 'skill is %s' % d.get('skill'); assert d.get('timestamp','')!='', 'observe timestamp empty'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 18
```

**NEXT:** TERMINAL -- run `/verify` next.
