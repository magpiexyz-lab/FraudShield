# STATE x1: GATHER_ALL_DATA

**PRECONDITIONS:**
- MVP list confirmed (STATE x0 POSTCONDITIONS met)
- `.runs/iterate-cross-context.json` exists with `mvps` array (each MVP has `name`, `domain`, `owner`, `campaign_name`, `final_url`, `subaccount_name`, `subaccount_id`)

**ACTIONS:**

### Read context

Read `.runs/iterate-cross-context.json` and extract the `mvps` array.

### Read operator config (with safe defaults)

Read `experiment/iterate-cross-config.yaml` from the operator's repo root if it exists. If missing, use these inline defaults and emit a one-time notice:

```yaml
signup_whitelist:
  - signup_complete
  - waitlist_signup
  - waitlist_submit
  - early_access_signup
  - activate
conversion_action_whitelist:
  - "Sign-up"
  - "MVP Signup"
  - "Submit lead form"
  - "Sign-ups"
mvp_mappings: {}
thresholds:
  signups_go: 3
  clicks_floor: 50
  click_window_days: 7
```

If config is missing, write a notice exactly once:
> "No `experiment/iterate-cross-config.yaml` found. Using defaults. See `experiment/iterate-cross-config.example.yaml` for the schema."

### Gather Google Ads data (Chrome MCP)

For each MVP's campaign in Google Ads MCC:

1. Navigate to the campaign's **Overview** or **Campaigns** tab
2. Record core metrics:
   - **Impressions**: total impressions
   - **Clicks**: total clicks
   - **CTR**: click-through rate (clicks / impressions)
   - **Avg CPC**: average cost per click
   - **Total spend**: total cost
3. Read **Bid strategy type**:
   - First try: locate the **Bid strategy** column in the campaigns table (may need to add via "Columns" → enable "Bid strategy")
   - Fallback: click into the campaign → **Settings** → **Bidding**. Read the bidding strategy.
   - Record `bid_strategy_type` as one of: `manual_cpc`, `maximize_clicks`, `target_cpa`, `target_roas`, `maximize_conversions`, `enhanced_cpc`, `unknown`
   - If neither approach succeeds, set `bid_strategy_type: "unknown"` and `bid_strategy_unknown: true`
4. Navigate to the campaign's **Keywords** tab
5. Record **Quality Score**:
   - Read the Quality Score column for each keyword
   - Filter: only keywords with >= 10 impressions
   - Compute the average Quality Score across qualifying keywords
   - If no keywords have >= 10 impressions, set `quality_score: 0`
6. Check for **Impression Share** (if visible in the columns):
   - Record Search Impression Share if available
   - If not visible, set `impression_share: null`

### Pull sub-account default conversion action (Chrome MCP)

For each unique sub-account across the MVPs:

1. Switch to the sub-account in Google Ads
2. Navigate to **Tools & Settings** → **Conversions** → **Goals** (or **Summary**)
3. Find the conversion goal labeled **Account default** (or the highest-priority **Primary** action)
4. Record:
   - `subaccount_default_conversion_action`: the action's name (e.g., `"Sign-up"`, `"Page view"`, `"Qualified lead"`)
   - `subaccount_conversion_status`: `"active"` | `"misconfigured"` | `"inactive"` (if visible from the row's Status column)

Cache the per-sub-account result and apply to all MVPs in that sub-account.

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

### Query PostHog funnel-stage data for each MVP

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

### Query PostHog tracking-health metrics per MVP

For each MVP, run two additional queries to detect tracking issues. See the "Cross-MVP Health & Signup Queries" section in `.claude/stacks/analytics/posthog.md` for templates.

**Combined gclid + total events** (one query):

```bash
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT count(*) AS total_events_count, countIf(properties.$session_entry_gclid IS NOT NULL AND properties.$session_entry_gclid != '\'''\'') AS gclid_visitor_count FROM events WHERE properties.$current_url LIKE {url_pattern} AND timestamp >= {start_date}",
      "values": {
        "url_pattern": "%<deploy_domain>%",
        "start_date": "<campaign_start_date ISO>"
      }
    }
  }'
```

Record per MVP:
- `total_events_count`: integer (any event firing for the deploy domain in the time window)
- `gclid_visitor_count`: integer (events with `$session_entry_gclid` set)

If `$session_entry_gclid` is unavailable in the team's PostHog project (older PostHog deployments), fall back to: `countIf(properties.gclid IS NOT NULL)`.

### Pre-compute signups (whitelist-based) per MVP

For each MVP, count distinct users who fired any event in `signup_whitelist` (from operator config) AND have a gclid:

```bash
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT count(DISTINCT distinct_id) AS signups FROM events WHERE event IN {events} AND properties.$session_entry_gclid IS NOT NULL AND properties.$current_url LIKE {url_pattern} AND timestamp >= {start_date}",
      "values": {
        "events": ["signup_complete","waitlist_signup","waitlist_submit","early_access_signup","activate"],
        "url_pattern": "%<deploy_domain>%",
        "start_date": "<campaign_start_date ISO>"
      }
    }
  }'
```

Replace the `events` array with the operator's `signup_whitelist` from config. Record `signups` per MVP — this drives the 3/50 verdict in STATE x3.

### Map PostHog funnel results to funnel stages

For each MVP, map the funnel-stage query results to the standard funnel stages:
- `reach`, `demand`, `activate`, `monetize`, `retain`. Missing stages → 0.

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
        #     'owner': 'lee',
        #     'campaign_name': 'pettracker-search-v1',
        #     'subaccount_name': 'Lee MVP',
        #     'deploy_url': 'https://pettracker.vercel.app',
        #     'google_ads': {
        #         'impressions': 1200,
        #         'clicks': 42,
        #         'ctr': 0.035,
        #         'cpc': 2.38,
        #         'spend': 100.00,
        #         'quality_score': 7,
        #         'impression_share': null,
        #         'bid_strategy_type': 'manual_cpc',
        #         'bid_strategy_unknown': false
        #     },
        #     'posthog': {
        #         'reach': 42,
        #         'demand': 4,
        #         'activate': 3,
        #         'monetize': 0,
        #         'retain': 0
        #     },
        #     'tracking': {
        #         'gclid_visitor_count': 38,
        #         'total_events_count': 412,
        #         'signups': 4
        #     },
        #     'subaccount_default_conversion_action': 'Sign-up',
        #     'subaccount_conversion_status': 'active',
        #     'has_funnel_stage': true,
        #     'data_source': 'project_name'  # or 'url_fallback'
        # }
    ]
}
json.dump(data, open('.runs/iterate-cross-data.json', 'w'), indent=2)
"
```

Replace placeholder data with actual values from Google Ads and PostHog.

**POSTCONDITIONS:**
- Google Ads data collected for every MVP including `bid_strategy_type`
- PostHog funnel-stage data collected for every MVP
- Tracking-health metrics (`gclid_visitor_count`, `total_events_count`) collected per MVP
- `signups` (whitelist-based, gclid-filtered) pre-computed per MVP
- Sub-account default conversion action recorded per MVP
- `.runs/iterate-cross-data.json` exists with complete extended schema

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x1`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; m=ms[0]; assert m.get('name'), 'first mvp name empty'; ga=m.get('google_ads',{}); assert 'impressions' in ga and 'clicks' in ga and 'spend' in ga and 'bid_strategy_type' in ga, 'google_ads missing keys'; ph=m.get('posthog',{}); assert 'reach' in ph and 'demand' in ph, 'posthog missing funnel stages'; tr=m.get('tracking',{}); assert 'gclid_visitor_count' in tr and 'total_events_count' in tr and 'signups' in tr, 'tracking missing keys'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x1
```

**NEXT:** Read [state-x1a-validate-data-integrity.md](state-x1a-validate-data-integrity.md) to continue.
