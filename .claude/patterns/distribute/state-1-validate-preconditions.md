# STATE 1: VALIDATE_PRECONDITIONS

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
   4. If the channel restricts or bans the category, warn the user: "⚠ Your experiment mentions [keyword]. [Channel] [restricts/bans] this category: [details]. Consider switching to [alternative channels that allow it]."
   5. Non-blocking — the user can confirm to proceed or switch channel
8. Verify `stack.analytics` is present in experiment.yaml. If not, stop: "Analytics is required for distribution tracking. Add `analytics: posthog` (or another provider) to experiment.yaml `stack` and run `/change add analytics` to scaffold analytics support, then re-run `/distribute`."
9. Verify the analytics stack is configured: read the analytics stack file's `env` frontmatter. If `env.client` lists a client env var, check that it appears in `.env.example`. If the env var is not found in `.env.example`, stop: "Analytics is not configured. Verify `.env.example` contains the analytics client key, or run `/bootstrap` first to scaffold the app with analytics." If `env.client` is empty, the stack uses hardcoded keys (e.g., PostHog's shared publishable key) — skip this check.
10. **Live analytics verification:** Read `name` from experiment.yaml and `deployed_at` from `.runs/deploy-manifest.json`. Read `stack.analytics` value from experiment.yaml and read the analytics stack file at `.claude/stacks/analytics/<value>.md`. Find the **Auto Query** section — it contains provider-specific credential setup, project discovery, and query syntax. Follow the Auto Query instructions to verify live events:
    - Read `experiment/EVENTS.yaml` and collect all event names where `funnel_stage` is `reach` (e.g., `visit_landing` for web-app, `api_call` for service, `command_run` for CLI).
    - Query for ANY of these reach-stage events filtered by `project_name = '<name>'` since `<deployed_at>`.
    - If count > 0 for any reach event, log "Analytics verified: reach events found ([event names])" and continue.
    - If count = 0 for all reach events, run a secondary diagnostic query for ALL events matching the project name since deployment.
    - If the secondary query returns other events but no reach-stage events, stop: "Analytics is receiving events from your app, but no reach-stage events (visit_landing, api_call, command_run) from the surface. The surface page analytics may be broken. Check the landing page/root handler code for missing tracking imports."
    - If the secondary query also returns 0 events, stop: "No analytics events found for project '<name>' since deployment. Open <deployed_url> in your browser, wait 60 seconds, then re-run `/distribute`."
    - If the analytics stack file has no Auto Query section, skip live verification and log: "Live analytics verification skipped — provider does not support auto-query. Verify manually that events are flowing."
11. If `experiment/ads.yaml` already exists, ask: "An ads config already exists. Generate a new version (v2)?"
12. **Landing page PageSpeed check (Phase 1 only):**
    Read `phase` from `.runs/distribute-context.json`. If phase is 1:
    1. Read the deployed URL from check 5 above
    2. Query PageSpeed Insights API:
       ```bash
       SCORE=$(curl --max-time 30 -s "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=$DEPLOYED_URL&strategy=mobile&category=performance" | python3 -c "
       import json, sys
       data = json.load(sys.stdin)
       score = data.get('lighthouseResult', {}).get('categories', {}).get('performance', {}).get('score', 0)
       print(int(score * 100))
       ")
       echo "PageSpeed mobile score: $SCORE"
       ```
    3. If score >= 70: log "PageSpeed mobile: [score]/100 (meets Phase 1 threshold)"
    4. If score < 70: WARN (non-blocking): "PageSpeed mobile: [score]/100 (below Phase 1 threshold of 70). Ads may underperform with slow landing pages. Consider running `/change improve landing page performance` before enabling the campaign."
    5. If curl fails (network error, timeout): WARN (non-blocking): "PageSpeed check failed (network error). Verify manually at https://pagespeed.web.dev/"
    This is a WARNING, not a blocker — the skill continues regardless of the score.

13. **Ad-readiness checks (Phase 1 + google-ads only):**
    Read `phase` from `.runs/distribute-context.json` and `channel` from the selected channel. If phase is not 1 or channel is not google-ads, skip checks 13a-13e.

    **13a: gclid capture**
    ```bash
    grep -r 'gclid' src/ site/ 2>/dev/null | grep -v node_modules | grep -v '.yaml' | grep -v '.md'
    ```
    - PASS: at least one match in `.ts`/`.tsx`/`.js`/`.jsx` that reads `gclid` from URL params
    - FAIL: landing page does not capture Google Click ID

    **13b: Unified funnel_stage**
    Read `experiment/EVENTS.yaml`. For every event in the `events` map, verify `funnel_stage` exists and is one of: `reach`, `demand`, `activate`, `monetize`, `retain`.
    - PASS: all events have valid `funnel_stage`
    - FAIL: list the event names missing `funnel_stage`

    **13c: Click ID in reach event properties**
    Read `experiment/EVENTS.yaml`. Find events where `funnel_stage` is `reach`. Verify at least one has `gclid` or `click_id` in its `properties`.
    - PASS: reach event defines gclid/click_id
    - FAIL: no reach event has gclid/click_id property

    **13d: UTM capture**
    ```bash
    grep -r 'utm_source' src/ site/ 2>/dev/null | grep -v node_modules | grep -v '.yaml' | grep -v '.md'
    ```
    - PASS: at least one match that reads `utm_source` from URL params
    - FAIL: landing page does not capture UTM parameters

    **13e: Conversion event exists**
    Read `experiment/EVENTS.yaml`. Check that at least one event has `funnel_stage: demand` or `funnel_stage: activate`.
    - PASS: at least one demand/activate event exists
    - FAIL (WARN only, non-blocking): "No conversion events in EVENTS.yaml. Google Ads needs a demand or activate stage event to track conversions."

    **Auto-fix flow (if any of 13a-13d FAIL):**

    1. Report failures:
       > "Ad-readiness check failed. These issues must be fixed before creating a campaign:"
       > - [list each failed check]
       > "I will fix these now and create a PR. After merge + deploy, re-run `/distribute`."

    2. Record in context:
       ```bash
       python3 -c "
       import json
       ctx = json.load(open('.runs/distribute-context.json'))
       ctx['ad_readiness_fix_needed'] = True
       json.dump(ctx, open('.runs/distribute-context.json', 'w'), indent=2)
       "
       ```

    3. Create fix branch:
       ```bash
       git stash
       git checkout main && git pull --ff-only
       git checkout -b fix/ad-readiness
       ```

    4. Apply fixes for each FAIL:
       - **13a fix:** Add gclid URL param reading to landing page component. Read archetype from experiment.yaml to find correct file (web-app: `src/app/page.tsx`). Add `const gclid = searchParams.get('gclid')` and include in the reach-stage track call.
       - **13b fix:** Edit EVENTS.yaml — add `funnel_stage` to events missing it. Use LLM to infer from event name: "visit/view" → reach, "signup/register" → demand, "create/complete" → activate, "pay/subscribe" → monetize, "return/revisit" → retain.
       - **13c fix:** Edit EVENTS.yaml — add `gclid` and `click_id` properties to the first reach-stage event.
       - **13d fix:** Add UTM param reading (`utm_source`, `utm_medium`, `utm_campaign`) to landing page component alongside the gclid fix.

    5. Verify and create PR:
       ```bash
       npm run build
       git add -A
       git commit -m "fix: add ad-readiness tracking (gclid, UTM, funnel_stage)"
       git push -u origin fix/ad-readiness
       gh pr create --title "Fix ad-readiness tracking" --body "Add missing gclid capture, UTM tracking, and/or funnel_stage definitions for Google Ads."
       ```

    6. **STOP — require deploy before continuing:**
       > "PR created: {pr_url}"
       >
       > "**You must merge this PR and deploy before continuing.**"
       > "Without these changes live, ad clicks won't be tracked and money will be wasted."
       >
       > "Steps:"
       > "1. Merge the PR"
       > "2. Run `/deploy`"
       > "3. Verify: visit deployed URL with `?gclid=test123&utm_source=test` — check analytics event has gclid"
       > "4. Re-run `/distribute` — it picks up where it left off"

       **Do not proceed to POSTCONDITIONS.** The skill terminates here. On re-run, state-1 re-executes and checks 13a-13d should now pass.

    **If only 13e FAIL (and 13a-13d all pass):** WARN only, continue to POSTCONDITIONS.

**POSTCONDITIONS:**
- experiment/experiment.yaml exists and is valid
- experiment/EVENTS.yaml exists with valid `events` dict
- package.json exists
- Deployed URL is known
- Distribution channel is selected and its stack file has been read
- Policy check completed (warning issued if applicable)
- Analytics stack is configured and verified
- Live analytics verification passed (reach-stage events found)
- PageSpeed check completed (Phase 1: score logged, warning if < 70)
- Ad-readiness checks passed (Phase 1 + google-ads: gclid, funnel_stage, UTM verified; or auto-fix PR created and skill stopped)

- **Write preconditions artifact** (`.runs/distribute-preconditions.json`):
  ```bash
  python3 -c "
  import json
  preconditions = {
      'experiment_valid': True,
      'events_valid': True,
      'deployed_url': '<url>',
      'channel': '<selected channel>',
      'analytics_verified': True,
      'phase': <phase from context>,
      'pagespeed_score': <score or None if check skipped/failed>,
      'ad_readiness_passed': True,  # True if 13a-13d passed (or phase != 1 / channel != google-ads)
      'ad_readiness_warnings': []   # e.g., ['13e: no conversion event']
  }
  json.dump(preconditions, open('.runs/distribute-preconditions.json', 'w'), indent=2)
  "
  ```

**VERIFY:**
```bash
test -f .runs/distribute-preconditions.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1
```

**NEXT:** Read [state-1_5-load-hypothesis.md](state-1_5-load-hypothesis.md) to continue.
