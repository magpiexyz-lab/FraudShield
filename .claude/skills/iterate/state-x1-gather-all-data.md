# STATE x1: GATHER_ALL_DATA

**PRECONDITIONS:**
- MVP list confirmed (STATE x0 POSTCONDITIONS met)
- `.runs/iterate-cross-context.json` exists with `mvps` array

**ACTIONS:**

### Read context

Read `.runs/iterate-cross-context.json` and extract the `mvps` array. Each MVP has `name`, `domain`, `campaign_name`, `final_url`.

### Gather Google Ads data (Chrome MCP)

For each MVP's campaign in Google Ads MCC:

1. Navigate to the campaign's **Overview** or **Campaigns** tab
2. Record:
   - **Impressions**: total impressions
   - **Clicks**: total clicks
   - **CTR**: click-through rate (clicks / impressions)
   - **Avg CPC**: average cost per click
   - **Total spend**: total cost
3. Navigate to the campaign's **Keywords** tab
4. Record **Quality Score**:
   - Read the Quality Score column for each keyword
   - Filter: only keywords with >= 10 impressions
   - Compute the average Quality Score across qualifying keywords
   - If no keywords have >= 10 impressions, set `quality_score: 0`
5. Check for **Impression Share** (if visible in the columns):
   - Record Search Impression Share if available
   - If not visible, set `impression_share: null`

### Read PostHog API key

```bash
POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key 2>/dev/null)
```

If the file does not exist, STOP:
> "PostHog personal API key not found at `~/.posthog/personal-api-key`."
> "Create one at PostHog > Settings > Personal API Keys (scope: Query Read), then save it:"
> "```"
> "mkdir -p ~/.posthog && echo 'phx_YOUR_KEY' > ~/.posthog/personal-api-key"
> "```"
> "Then re-run `/iterate --cross`."

### Discover PostHog project ID

```bash
POSTHOG_PROJECT_ID=$(curl -s "https://us.i.posthog.com/api/projects/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
```

If this fails, report the error and STOP.

### Query PostHog data for each MVP

For each MVP, query funnel stage counts using HogQL. Try `project_name` match first, then fallback to URL domain match.

**Primary query** (new MVPs with `project_name` property):

```bash
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT properties.funnel_stage as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE properties.project_name = {project_name} AND properties.utm_source = {utm_source} AND timestamp >= {start_date} GROUP BY stage",
      "values": {
        "project_name": "<mvp_name>",
        "utm_source": "google",
        "start_date": "<campaign_start_date ISO>"
      }
    }
  }'
```

**Fallback query** (old MVPs without `project_name` -- use `$current_url` domain match):

If the primary query returns empty results, try:

```bash
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT properties.funnel_stage as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE properties.$current_url LIKE {url_pattern} AND properties.utm_source = {utm_source} AND timestamp >= {start_date} GROUP BY stage",
      "values": {
        "url_pattern": "%<deploy_domain>%",
        "utm_source": "google",
        "start_date": "<campaign_start_date ISO>"
      }
    }
  }'
```

**Important:** Always use parameterized `values` for all user-supplied inputs. Never use string interpolation.

### Map PostHog results to funnel stages

For each MVP, map the query results to the standard funnel stages:
- `reach`: users at funnel_stage = "reach"
- `demand`: users at funnel_stage = "demand"
- `activate`: users at funnel_stage = "activate"
- `monetize`: users at funnel_stage = "monetize"
- `retain`: users at funnel_stage = "retain"

If a stage is missing from results, set it to 0.

Track whether each MVP had `funnel_stage` data (for STATE x2 migration decision):
- `has_funnel_stage: true` if the primary query returned funnel_stage results
- `has_funnel_stage: false` if only fallback query worked or no funnel_stage in results

### Write data file

```bash
python3 -c "
import json

data = {
    'mvps': [
        # For each MVP:
        # {
        #     'name': 'pettracker',
        #     'deploy_url': 'https://pettracker.vercel.app',
        #     'google_ads': {
        #         'impressions': 1200,
        #         'clicks': 42,
        #         'ctr': 0.035,
        #         'cpc': 2.38,
        #         'spend': 100.00,
        #         'quality_score': 7,
        #         'impression_share': null
        #     },
        #     'posthog': {
        #         'reach': 42,
        #         'demand': 4,
        #         'activate': 3,
        #         'monetize': 0,
        #         'retain': 0
        #     },
        #     'has_funnel_stage': true,
        #     'data_source': 'project_name' or 'url_fallback'
        # }
    ]
}
json.dump(data, open('.runs/iterate-cross-data.json', 'w'), indent=2)
"
```

Replace placeholder data with actual values from Google Ads and PostHog.

**POSTCONDITIONS:**
- Google Ads data collected for every MVP (impressions, clicks, CTR, CPC, spend, quality score)
- PostHog data collected for every MVP (funnel stage counts)
- Each MVP flagged with `has_funnel_stage` for STATE x2 migration decision
- `.runs/iterate-cross-data.json` exists with complete data

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; m=ms[0]; assert m.get('name'), 'first mvp name empty'; ga=m.get('google_ads',{}); assert 'impressions' in ga and 'clicks' in ga and 'spend' in ga, 'google_ads missing keys'; ph=m.get('posthog',{}); assert 'reach' in ph and 'demand' in ph, 'posthog missing funnel stages'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x1
```

**NEXT:** Read [state-x2-migrate-events.md](state-x2-migrate-events.md) to continue.
