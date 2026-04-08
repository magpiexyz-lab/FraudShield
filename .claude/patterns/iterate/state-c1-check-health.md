# STATE c1: CHECK_HEALTH

**PRECONDITIONS:**
- Ads context read (STATE c0 POSTCONDITIONS met)
- Chrome MCP tools available

**ACTIONS:**

### Open Google Ads

1. Use Chrome MCP to navigate to `https://ads.google.com`
2. Verify login state -- if a login prompt is shown, tell the user:
   > "Please log into Google Ads in Chrome, then re-run `/iterate --check`."
   > STOP.
3. If the account uses an MCC (Manager Account), navigate to the correct sub-account using `account_id` from ads.yaml (if present) or `campaign_id`
4. Navigate to the campaign matching `campaign_name` from the context

### Health checks

Perform the following health checks via Chrome MCP (5 standard + conditional Check 6 when sitelinks exist). For each, navigate to the relevant section and read the UI:

#### Check 1: Ad approval status
- Navigate to the campaign's **Ads** tab
- Read the **Status** column for each ad
- Healthy: all ads show "Eligible" or "Approved"
- Issue type: `disapproved` -- record which ads are disapproved and their status text

#### Check 2: Impression count
- Navigate to the campaign **Overview** or check the **Impressions** column
- Read total impressions since campaign start
- Healthy: impressions > 0
- Issue type: `zero_impressions` -- record the exact impression count (0 or very low)

#### Check 3: Campaign status
- Check the campaign **Status** (visible on the campaign list or Settings page)
- Healthy: "Active" or "Enabled"
- Issue type: `campaign_paused` -- record the actual status (Paused, Ended, etc.)
- Note: `campaign_paused` is informational only -- if the user paused it intentionally, skip auto-fix

#### Check 4: Search terms report
- Navigate to **Keywords > Search terms**
- Look for irrelevant search terms that are consuming budget:
  - Terms with cost > $1 AND CTR < 1%
  - Terms clearly unrelated to the experiment (e.g., "free", "download", "tutorial" for a SaaS product)
- Healthy: no obviously wasted search terms
- Issue type: `wasted_clicks` -- record the problematic search terms with their cost and CTR

#### Check 5: Budget consumption rate
- Read total spend so far and compare against expected spend for the campaign age
  - Expected daily spend = `budget.daily_budget_cents` from ads.yaml
  - Expected total spend at current age = expected daily spend x campaign_age_days
  - Actual spend from the campaign dashboard
- Healthy: actual spend is between 30% and 150% of expected spend
- Issue type: `budget_anomaly` -- record actual vs expected spend and the anomaly direction (underspend/overspend)

#### Check 6: Sitelink approval status

**Skip condition:** Read `experiment/ads.yaml`. If `sitelinks` is missing, null, or an empty array, skip this check entirely. Log: "No sitelinks in ads.yaml -- skipping sitelink health check."

- Navigate to the campaign's **Ads & assets** → **Assets** tab (or **Extensions** tab in older UI versions)
- Filter or scroll to Sitelink type assets
- Read the **Status** column for each sitelink
- Healthy: all sitelinks show "Eligible", "Approved", or "Under review" (under review is expected for the first 24-48 hours)
- Issue type: `sitelink_disapproved` -- record which sitelinks are disapproved and their status/reason text

### Collect campaign metrics

While checking health, also record these metrics for the report:
- Total impressions
- Total clicks
- CTR (click-through rate)
- Average CPC
- Total spend
- Conversions (if shown)

### Write health report

```bash
python3 -c "
import json
health = {
    'campaign_name': '<name>',
    'campaign_id': '<id>',
    'checked_at': '<ISO 8601>',
    'metrics': {
        'impressions': 0,
        'clicks': 0,
        'ctr_pct': 0.0,
        'avg_cpc_cents': 0,
        'spend_cents': 0,
        'conversions': 0
    },
    'checks': [
        {'check_name': '<name>', 'status': '<healthy|issue>', 'details': '<details>', 'issue_type': None}
    ],
    'issues': [],
    'overall_status': '<healthy|issues_found>'
}
# Populate issues from checks where status == 'issue'
health['issues'] = [c for c in health['checks'] if c['status'] == 'issue']
health['overall_status'] = 'issues_found' if health['issues'] else 'healthy'
json.dump(health, open('.runs/iterate-check-health.json', 'w'), indent=2)
"
```

Replace all placeholder values with actual data collected from Chrome MCP.

**POSTCONDITIONS:**
- All health checks performed via Chrome MCP (5 standard + conditional sitelink check when ads.yaml has sitelinks)
- Campaign metrics collected
- `.runs/iterate-check-health.json` exists with structured results

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-check-health.json')); assert d.get('campaign_name'), 'campaign_name empty'; assert d.get('checked_at'), 'checked_at empty'; m=d.get('metrics',{}); assert 'impressions' in m and 'clicks' in m, 'metrics missing impressions or clicks'; assert isinstance(d.get('checks'), list), 'checks not a list'; assert d.get('overall_status') in ('healthy','issues_found'), 'overall_status=%s' % d.get('overall_status')"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-check c1
```

**NEXT:** Read [state-c2-auto-fix.md](state-c2-auto-fix.md) to continue.
