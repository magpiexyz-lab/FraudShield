# STATE 4: CLEANUP

**PRECONDITIONS:**
- Deletion verified (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

### Step 4: Cleanup

1. Delete `.runs/deploy-manifest.json`
2. Remove `.env.local` if it exists (contains deployed credentials that are now invalid).
   Ask user first: "`.env.local` contains credentials for the deleted infrastructure.
   Delete it? (y/n)"
3. Write cleanup manifest:
   ```bash
   python3 -c "
   import json, datetime
   manifest = {
       'timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
       'deploy_manifest_deleted': True,
       'env_local_deleted': '<true-or-false>'
   }
   with open('.runs/teardown-cleanup.json', 'w') as f:
       json.dump(manifest, f, indent=2)
   "
   ```

### Q-score

Compute teardown quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/teardown-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
Q_DELETION=$(test ! -f .runs/deploy-manifest.json && echo "1.0" || echo "0.0")
python3 .claude/scripts/write-q-score.py \
  --skill teardown --scope teardown \
  --archetype "$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('type','web-app'))" 2>/dev/null || echo web-app)" \
  --gate 1.0 --dims "{\"deletion\": $Q_DELETION, \"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

### Step 5: Summary

```
## Teardown Complete

**Deleted:**
- [For each successfully deleted resource] <provider> <resource type> <id>
- PostHog dashboard #<id>

**Failed (manual cleanup needed):**
- <resource> — <dashboard URL from stack file's Teardown section>

**External services (manual cleanup):**
- <service> — <dashboard URL>

**Deletion Verification:**
[Include provision scanner output table from STATE 3]

**Local cleanup:**
- .runs/deploy-manifest.json deleted
- [.env.local deleted / .env.local kept]

**What's preserved:**
- All source code on main branch
- experiment.yaml, experiment/EVENTS.yaml (experiment definition)
- Migration files (can re-deploy with /deploy)

To re-deploy this experiment: run `/deploy` again.
To archive this experiment: `gh release create v1.0 --notes "Experiment <name> concluded"`
```

**POSTCONDITIONS:**
- `.runs/deploy-manifest.json` deleted
- `.env.local` deleted (if user approved) or kept
- Summary printed to user

**VERIFY:**
```bash
test ! -f .runs/deploy-manifest.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh teardown 4
```

**NEXT:** Read [state-5-skill-epilogue.md](state-5-skill-epilogue.md) to continue.
