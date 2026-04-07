# STATE 1c: ANALYTICS_CONFIG

**PRECONDITIONS:**
- Policy check completed (STATE 1b POSTCONDITIONS met)

**ACTIONS:**

> **Branch cleanup on failure:** Any "stop" in this step leaves you on a feature branch (created in Step 0). Include in the stop message: "To abort: `git checkout main && git branch -D chore/distribute`. To fix and retry: address the prerequisite, then re-run `/distribute`."

1. If `experiment/ads.yaml` already exists, ask: "An ads config already exists. Generate a new version (v2)?"
2. Verify `stack.analytics` is present in experiment.yaml. If not, stop: "Analytics is required for distribution tracking. Add `analytics: posthog` (or another provider) to experiment.yaml `stack` and run `/change add analytics` to scaffold analytics support, then re-run `/distribute`."
3. Verify the analytics stack is configured: read the analytics stack file's `env` frontmatter. If `env.client` lists a client env var, check that it appears in `.env.example`. If the env var is not found in `.env.example`, stop: "Analytics is not configured. Verify `.env.example` contains the analytics client key, or run `/bootstrap` first to scaffold the app with analytics." If `env.client` is empty, the stack uses hardcoded keys (e.g., PostHog's shared publishable key) — skip this check.

**POSTCONDITIONS:**
- Analytics configuration verified
- `.runs/distribute-preconditions.json` updated with `analytics_configured: true`

Update the preconditions artifact:
```bash
python3 -c "
import json
p = json.load(open('.runs/distribute-preconditions.json'))
p['analytics_configured'] = True
json.dump(p, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**VERIFY:**
```bash
python3 -c "
import json; p=json.load(open('.runs/distribute-preconditions.json'))
assert p.get('analytics_configured'), 'analytics not configured'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1c
```

**NEXT:** Read [state-2-validate-analytics.md](state-2-validate-analytics.md) to continue.
