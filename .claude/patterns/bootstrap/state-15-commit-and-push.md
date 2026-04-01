# STATE 15: COMMIT_AND_PUSH

**PRECONDITIONS:**
- Wire done (STATE 14 POSTCONDITIONS met)
- Checkpoint is `awaiting-verify`

**ACTIONS:**

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

- Delete `.runs/current-visual-brief.md` (keep `.runs/current-plan.md` -- `/verify` needs it)
- Tell the user: "Bootstrap pushed. Run `/verify` to run verification and create the PR." If archetype is `cli` and surface is not `none`, add: "After merging, run `/deploy` for the marketing surface, then `npm publish` for the CLI binary." If archetype is `cli` and surface is `none`, add: "After merging, run `npm publish` for the CLI binary (no surface to deploy)."

If `quality: production` is set in experiment.yaml, add to the user message:
> "Bootstrap complete with production quality mode. After `/verify`, run `/harden` to add TDD coverage to critical paths (auth, payment, data persistence)."

Check off in `.runs/current-plan.md`: `- [x] BG4 PR Gate passed`

**POSTCONDITIONS:**
- All files committed (no uncommitted tracked changes)
- BG4 PR Gate verdict is PASS
- Branch pushed to remote
- `.runs/current-visual-brief.md` deleted

**VERIFY:**
```bash
git status --porcelain | grep -v '??' | wc -l | xargs test 0 -eq && echo "Clean" || echo "Uncommitted changes"
git log -1 --oneline | grep -q "Bootstrap MVP scaffold" && echo "Commit OK" || echo "Commit FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 15
```

**NEXT:** TERMINAL -- run `/verify` next.
