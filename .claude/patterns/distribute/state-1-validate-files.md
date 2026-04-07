# STATE 1: VALIDATE_FILES

**PRECONDITIONS:**
- On `chore/distribute*` branch (STATE 0 POSTCONDITIONS met)

**ACTIONS:**

> **Branch cleanup on failure:** Any "stop" in this step leaves you on a feature branch (created in Step 0). Include in the stop message: "To abort: `git checkout main && git branch -D chore/distribute`. To fix and retry: address the prerequisite, then re-run `/distribute`."

1. Verify `experiment/experiment.yaml` exists and is complete. If not, stop: "No experiment found. Create `experiment/experiment.yaml` from the template first, then run `/bootstrap`."
2. Verify `experiment/EVENTS.yaml` exists. If not, stop: "experiment/EVENTS.yaml not found. This file defines all analytics events and is required."
3. Verify `experiment/EVENTS.yaml` contains an `events` key that is a dict (flat map). If not, stop: "experiment/EVENTS.yaml is malformed — the `events` key is missing or not a dict. Run `make validate` to diagnose, or restore the file from the template."
4. Verify `package.json` exists. If not, stop: "No app found. Run `/bootstrap` first to create the app, deploy it, then run `/distribute`."
5. Verify the app is deployed: check `landing_url` in existing `experiment/ads.yaml`, or check `surface_url` (then `canonical_url`) in `.runs/deploy-manifest.json`, or ask the user for the deployed URL. For CLI archetype, the surface URL IS the target URL. If the user does not have a deployed URL, stop: "The app must be deployed before running `/distribute` — ad campaigns need a live surface page. Run `/deploy` first, then re-run `/distribute`."

**POSTCONDITIONS:**
- All file and deployment checks passed
- `.runs/distribute-preconditions.json` written with field: `deployed_url`

Write the preconditions artifact:
```bash
python3 -c "
import json
preconditions = {
    'deployed_url': '<url>'
}
json.dump(preconditions, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**VERIFY:**
```bash
python3 -c "
import json; p=json.load(open('.runs/distribute-preconditions.json'))
assert p.get('deployed_url'), 'no deployed_url'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1
```

**NEXT:** Read [state-1a-channel-selection.md](state-1a-channel-selection.md) to continue.
