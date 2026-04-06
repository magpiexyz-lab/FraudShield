# STATE x1: GATHER_ALL_DATA

**PRECONDITIONS:**
- MVP list confirmed (STATE x0 POSTCONDITIONS met)
- `.runs/iterate-cross-mvps.json` exists

**ACTIONS:**

### Google Ads data (via Chrome MCP)

For each MVP in `.runs/iterate-cross-mvps.json`:

1. Navigate to the campaign in Google Ads via Chrome MCP (use the account_id to switch sub-accounts if needed)
2. Collect from the campaign **Overview** or **Columns**:
   - `impressions`: total impressions
   - `clicks`: total clicks
   - `ctr`: click-through rate (as decimal, e.g., 0.035 for 3.5%)
   - `avg_cpc`: average cost per click in dollars
   - `spend`: total spend in dollars
3. Collect **Quality Score** from the **Keywords** tab:
   - Filter to keywords with >= 10 impressions (low-impression keywords have unreliable QS)
   - Read the Quality Score column for each qualifying keyword
   - Compute the average Quality Score (1-10 scale)
   - If no keywords have >= 10 impressions, set `quality_score: 0` (will trigger QS fallback in scoring)
4. Check for **Impression Share** if visible in columns:
   - `impression_share`: percentage (e.g., 0.45 for 45%)
   - If not visible, set to `null`

### PostHog data (via HogQL API)

Read the PostHog analytics stack file at `.claude/stacks/analytics/posthog.md`, section "Auto Query".

1. Check credential:
   ```bash
   test -f ~/.posthog/personal-api-key
   ```
   If missing, STOP:
   > "PostHog API key not found. Create a Personal API Key in PostHog (Settings > Personal API Keys > Create key, scope: Query Read) and save it to `~/.posthog/personal-api-key`. Then re-run `/iterate --cross`."

2. Discover PostHog project ID:
   ```bash
   POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key)
   POSTHOG_PROJECT_ID=$(curl -s "https://us.i.posthog.com/api/projects/" \
     -H "Authorization: Bearer $POSTHOG_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
   ```

3. For each MVP, query PostHog using the MVP's `name` as `project_name`:
   ```bash
   curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $POSTHOG_API_KEY" \
     -d '{
       "query": {
         "kind": "HogQLQuery",
         "query": "SELECT properties.funnel_stage as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE properties.project_name = {project_name} AND properties.utm_source = '\''google'\'' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY stage",
         "values": {
           "project_name": "<mvp_name>"
         }
       }
     }'
   ```

4. If `project_name` matching returns no results (old MVP without `project_name` property), fall back to domain matching using the MVP's `deploy_url`:
   ```bash
   curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $POSTHOG_API_KEY" \
     -d '{
       "query": {
         "kind": "HogQLQuery",
         "query": "SELECT properties.funnel_stage as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE properties.$current_url LIKE {url_pattern} AND properties.utm_source = '\''google'\'' AND timestamp >= now() - INTERVAL 30 DAY GROUP BY stage",
         "values": {
           "url_pattern": "%<deploy_domain>%"
         }
       }
     }'
   ```

5. Parse the HogQL results into funnel stage counts:
   - Map `stage` values to: `reach`, `demand`, `activate`, `monetize`, `retain`
   - If `funnel_stage` data is present in results, set `has_funnel_stage: true`
   - If no `funnel_stage` results (old MVP without typed wrappers), set `has_funnel_stage: false` -- STATE x2 will handle migration

6. Also check if individual event names are returned (for old MVPs):
   ```bash
   curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $POSTHOG_API_KEY" \
     -d '{
       "query": {
         "kind": "HogQLQuery",
         "query": "SELECT event, count(*) as count FROM events WHERE properties.project_name = {project_name} AND timestamp >= now() - INTERVAL 30 DAY GROUP BY event ORDER BY count DESC",
         "values": {
           "project_name": "<mvp_name>"
         }
       }
     }'
   ```
   Store raw event names for use in STATE x2 migration.

### Write consolidated data

```bash
python3 -c "
import json
data = {
    'mvps': [
        {
            'name': '<mvp_name>',
            'deploy_url': '<url>',
            'google_ads': {
                'impressions': 0,
                'clicks': 0,
                'ctr': 0.0,
                'avg_cpc': 0.0,
                'spend': 0.0,
                'quality_score': 0,
                'impression_share': None
            },
            'posthog': {
                'has_funnel_stage': True,
                'reach': 0,
                'demand': 0,
                'activate': 0,
                'monetize': 0,
                'retain': 0,
                'raw_events': {}
            },
            'match_method': '<project_name|domain_fallback>'
        }
    ]
}
json.dump(data, open('.runs/iterate-cross-data.json', 'w'), indent=2)
"
```

Replace all placeholder values with actual data from Chrome MCP and PostHog API queries.

**POSTCONDITIONS:**
- Google Ads metrics collected for every MVP via Chrome MCP
- PostHog funnel data queried for every MVP via HogQL API
- `.runs/iterate-cross-data.json` exists with both `google_ads` and `posthog` data per MVP

**VERIFY:**
```bash
test -f .runs/iterate-cross-data.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x1
```

**NEXT:** Read [state-x2-migrate-events.md](state-x2-migrate-events.md) to continue.
