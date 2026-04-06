# STATE x0: DISCOVER_MVPS

**PRECONDITIONS:**
- Git repository exists in working directory

**ACTIONS:**

### Verify Chrome MCP availability

Use ToolSearch to check for Chrome MCP tools:
```
ToolSearch: query="claude-in-chrome", max_results=5
```

If no `mcp__claude-in-chrome__*` tools are returned, STOP:
> "Chrome MCP is required for --cross mode. It lets me read Google Ads campaign data across all sub-accounts."
> "Please connect the Claude-in-Chrome extension and ensure Chrome is open with Google Ads logged in to the MCC account, then re-run `/iterate --cross`."

### Open Google Ads MCC

1. Use Chrome MCP to navigate to `https://ads.google.com`
2. Verify login state -- if a login prompt is shown, STOP:
   > "Please log into Google Ads (MCC account) in Chrome, then re-run `/iterate --cross`."
3. Verify this is a Manager (MCC) account -- look for the "Accounts" or "Sub-accounts" navigation. If this is a regular account (not MCC), STOP:
   > "Cross-MVP evaluation requires a Manager (MCC) account to see all sub-accounts. Please switch to the MCC account in Google Ads, then re-run `/iterate --cross`."

### Discover campaigns across sub-accounts

1. Navigate to the MCC **Campaigns** view (which shows campaigns across all sub-accounts)
2. For each campaign visible, extract:
   - **Campaign name**
   - **Account name** (sub-account)
   - **Account ID** (Customer ID)
   - **Status** (Active / Paused / Ended)
   - **Final URL** (the landing page URL -- visible in Ads tab or campaign settings)
   - **Start date** and **End date** (or current date if still running)
   - **Total spend**

3. Filter campaigns:
   - Keep only campaigns whose status is **Ended** OR that have been running for **>= 7 days**
   - Exclude campaigns with status "Removed" or "Draft"
   - If no campaigns match, STOP:
     > "No completed campaigns found (need status Ended or running >= 7 days). Wait for campaigns to finish their measurement window, then re-run `/iterate --cross`."

4. For each qualifying campaign, extract the MVP identifier:
   - Use the **Final URL** domain as the primary identifier (e.g., `pettracker.vercel.app` -> `pettracker`)
   - Also record the full `deploy_url` for PostHog matching in STATE x1

### Confirm with Team Lead

Present the discovered MVPs for confirmation:

```
Found {N} MVPs with completed/mature campaigns:

| # | MVP Name | Deploy URL | Campaign | Status | Days | Spend |
|---|----------|-----------|----------|--------|------|-------|
| 1 | {name} | {url} | {campaign} | {status} | {days} | ${spend} |
| ... |

Proceed with cross-MVP evaluation for all {N}? (Reply "yes" or remove any MVPs from the list)
```

Wait for Team Lead confirmation before proceeding.

### Create context and MVP list

```bash
rm -f .runs/observe-result.json
python3 -c "
import json, datetime
mvps = [
    # Populate from Chrome MCP data
    {
        'name': '<mvp_name>',
        'deploy_url': '<full_url>',
        'campaign_name': '<campaign_name>',
        'account_id': '<customer_id>',
        'campaign_status': '<status>',
        'campaign_days': 0,
        'total_spend_cents': 0
    }
]
json.dump({'mvps': mvps, 'count': len(mvps)}, open('.runs/iterate-cross-mvps.json', 'w'), indent=2)

ctx = {
    'skill': 'iterate-cross',
    'mode': 'cross',
    'mvp_count': len(mvps),
    'branch': '$(git branch --show-current)',
    'timestamp': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'run_id': 'iterate-cross-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'completed_states': ['x0']
}
json.dump(ctx, open('.runs/iterate-cross-context.json', 'w'), indent=2)
"
```

Replace all placeholder values with actual data from Chrome MCP.

**POSTCONDITIONS:**
- Google Ads MCC accessed via Chrome MCP
- Campaign list discovered and filtered (status Ended or running >= 7 days)
- Team Lead confirmed the MVP list
- `.runs/iterate-cross-mvps.json` exists with MVP list
- `.runs/iterate-cross-context.json` exists

**VERIFY:**
```bash
test -f .runs/iterate-cross-mvps.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue.
