# STATE 2: VALIDATE_ANALYTICS

**PRECONDITIONS:**
- Prerequisites validated (STATE 1 POSTCONDITIONS met)

**ACTIONS:**

1. **project_name source match:**
   - Read `name` from experiment.yaml
   - Grep analytics files for `PROJECT_NAME` constant: always check `src/lib/analytics-server.ts`; check `src/lib/analytics.ts` only when it exists (web-app only — service/cli have no client analytics file)
   - Check if the constant value matches the experiment.yaml name
   - If match: write `project_name_verified: true, project_name_mismatch: false`
   - If mismatch or "TODO": write `project_name_verified: true, project_name_mismatch: true` — do NOT stop, State 3 will fix it
   - Check command:
     ```bash
     EXPECTED=$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('name', ''))")
     if [ ! -f src/lib/analytics-server.ts ]; then
       echo "STOP: Analytics library files not found. Run /bootstrap first to scaffold analytics support, then re-run /distribute."
       exit 1
     fi
     MATCH=true
     if [ -f src/lib/analytics.ts ]; then
       grep -q "PROJECT_NAME = \"$EXPECTED\"" src/lib/analytics.ts 2>/dev/null || MATCH=false
     fi
     grep -q "PROJECT_NAME = \"$EXPECTED\"" src/lib/analytics-server.ts 2>/dev/null || MATCH=false
     $MATCH
     ```

2. **Live analytics verification:**
   - Read `name` from experiment.yaml and `deployed_at` from `.runs/deploy-manifest.json`
   - Read `stack.analytics` value from experiment.yaml and read the analytics stack file at `.claude/stacks/analytics/<value>.md`
   - Find the **Auto Query** section — follow its instructions to verify live events
   - Read `experiment/EVENTS.yaml` and collect all event names where `funnel_stage` is `reach` (e.g., `visit_landing` for web-app, `api_call` for service, `command_run` for CLI)
   - Query for ANY of these reach-stage events filtered by `project_name = '<name>'` since `<deployed_at>`
   - If count > 0 for any reach event: log "Analytics verified: reach events found ([event names])" and write `analytics_live: true`
   - If count = 0 for all reach events, run a secondary diagnostic query for ALL events matching the project name since deployment
   - If the secondary query returns other events but no reach-stage events: stop "Analytics is receiving events from your app, but no reach-stage events (visit_landing, api_call, command_run) from the surface. The surface page analytics may be broken. Check the landing page/root handler code for missing tracking imports."
   - If the secondary query also returns 0 events: stop "No analytics events found for project '<name>' since deployment. Open <deployed_url> in your browser, wait 60 seconds, then re-run `/distribute`."
   - If the analytics stack file has no Auto Query section, skip live verification and log: "Live analytics verification skipped — provider does not support auto-query. Verify manually that events are flowing." Write `analytics_live: true`.

3. **Load hypothesis:**
   - If `.runs/spec-manifest.json` exists, read it and extract all hypotheses where `category` is `"demand"` or `"reach"` (the categories relevant to distribution). For each: `statement`, `metric.formula`, `metric.threshold`.
   - Store as hypothesis context for State 4 GENERATE. If the file does not exist, skip — all subsequent states work without it.
   - Write `hypothesis_loaded: true/false` to preconditions

4. **PageSpeed check (Phase 1 only):**
   - Read `phase` from `.runs/distribute-context.json`. If phase is 1:
     1. Read the deployed URL from preconditions
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
   - This is a WARNING, not a blocker — the skill continues regardless of the score.
   - If phase is not 1, skip this check.
   - Write `pagespeed_score` to preconditions (integer score, or `null` if skipped/failed)

**POSTCONDITIONS:**
- project_name check completed (verified or mismatch recorded)
- Live analytics verification passed
- Hypothesis loaded or skipped
- PageSpeed checked (Phase 1) or skipped
- `.runs/distribute-preconditions.json` updated with: `project_name_verified`, `project_name_mismatch`, `analytics_live`, `hypothesis_loaded`, `pagespeed_score`

Update the preconditions artifact:
```bash
python3 -c "
import json
p = json.load(open('.runs/distribute-preconditions.json'))
p['project_name_verified'] = True  # or False
p['project_name_mismatch'] = False  # or True
p['analytics_live'] = True
p['hypothesis_loaded'] = True  # or False
p['pagespeed_score'] = None  # or integer
json.dump(p, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**VERIFY:**
```bash
python3 -c "import json; p=json.load(open('.runs/distribute-preconditions.json')); assert p.get('project_name_verified') is not None; assert p.get('analytics_live')"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 2
```

**NEXT:** Read [state-3-implement-and-verify.md](state-3-implement-and-verify.md) to continue.
