# STATE 1: VALIDATE_PREREQUISITES

**PRECONDITIONS:**
- On `chore/distribute*` branch (STATE 0 POSTCONDITIONS met)

**ACTIONS:**

> **Branch cleanup on failure:** Any "stop" in this step leaves you on a feature branch (created in Step 0). Include in the stop message: "To abort: `git checkout main && git branch -D chore/distribute`. To fix and retry: address the prerequisite, then re-run `/distribute`."

1. Verify `experiment/experiment.yaml` exists and is complete. If not, stop: "No experiment found. Create `experiment/experiment.yaml` from the template first, then run `/bootstrap`."
2. Verify `experiment/EVENTS.yaml` exists. If not, stop: "experiment/EVENTS.yaml not found. This file defines all analytics events and is required."
3. Verify `experiment/EVENTS.yaml` contains an `events` key that is a dict (flat map). If not, stop: "experiment/EVENTS.yaml is malformed — the `events` key is missing or not a dict. Run `make validate` to diagnose, or restore the file from the template."
4. Verify `package.json` exists. If not, stop: "No app found. Run `/bootstrap` first to create the app, deploy it, then run `/distribute`."
5. Verify the app is deployed: check `landing_url` in existing `experiment/ads.yaml`, or check `surface_url` (then `canonical_url`) in `.runs/deploy-manifest.json`, or ask the user for the deployed URL. For CLI archetype, the surface URL IS the target URL. If the user does not have a deployed URL, stop: "The app must be deployed before running `/distribute` — ad campaigns need a live surface page. Run `/deploy` first, then re-run `/distribute`."
6. **Channel selection:**
   1. List available channels by scanning `.claude/stacks/distribution/*.md` (strip the `.md` extension to get channel names)
   2. Ask: "Which distribution channel? Available: [channels]. Enter channel name:"
   3. Read the selected channel's stack file at `.claude/stacks/distribution/<channel>.md`

7. **Policy check:**
   1. Read experiment.yaml `description`
   2. Match against restricted-industry keywords: `crypto`, `DeFi`, `token`, `ICO`, `blockchain`, `NFT`, `yield`, `staking`, `liquidity`, `protocol`, `wallet`, `exchange`, `mining`, `DAO`
   3. If match found, read the selected channel's "Policy Restrictions" section
   4. If the channel restricts or bans the category, warn the user: "Your experiment mentions [keyword]. [Channel] [restricts/bans] this category: [details]. Consider switching to [alternative channels that allow it]."
   5. Non-blocking — the user can confirm to proceed or switch channel
8. **Combined checks:**
   1. If `experiment/ads.yaml` already exists, ask: "An ads config already exists. Generate a new version (v2)?"
   2. Verify `stack.analytics` is present in experiment.yaml. If not, stop: "Analytics is required for distribution tracking. Add `analytics: posthog` (or another provider) to experiment.yaml `stack` and run `/change add analytics` to scaffold analytics support, then re-run `/distribute`."
   3. Verify the analytics stack is configured: read the analytics stack file's `env` frontmatter. If `env.client` lists a client env var, check that it appears in `.env.example`. If the env var is not found in `.env.example`, stop: "Analytics is not configured. Verify `.env.example` contains the analytics client key, or run `/bootstrap` first to scaffold the app with analytics." If `env.client` is empty, the stack uses hardcoded keys (e.g., PostHog's shared publishable key) — skip this check.

**POSTCONDITIONS:**
- All prerequisite checks passed
- `.runs/distribute-preconditions.json` written with fields: `deployed_url`, `channel`, `policy_checked: true`, `analytics_configured: true`

Write the preconditions artifact:
```bash
python3 -c "
import json
preconditions = {
    'deployed_url': '<url>',
    'channel': '<selected channel>',
    'policy_checked': True,
    'analytics_configured': True
}
json.dump(preconditions, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**VERIFY:**
```bash
python3 -c "
import json; p=json.load(open('.runs/distribute-preconditions.json'))
assert p.get('deployed_url'), 'no deployed_url'
assert p.get('channel'), 'no channel'
assert p.get('policy_checked'), 'policy check skipped'
assert p.get('analytics_configured'), 'analytics not configured'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1
```

**NEXT:** Read [state-2-validate-analytics.md](state-2-validate-analytics.md) to continue.
