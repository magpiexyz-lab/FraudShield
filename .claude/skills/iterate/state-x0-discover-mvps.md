# STATE x0: DISCOVER_MVPS

**PRECONDITIONS:**
- Team Lead has Chrome open and is logged into Google Ads MCC

**ACTIONS:**

### Verify Chrome MCP availability

Use ToolSearch to check for Chrome MCP tools:
```
ToolSearch: query="claude-in-chrome", max_results=5
```

If no `mcp__claude-in-chrome__*` tools are returned, STOP and show the setup guide:

1. Read `.claude/patterns/chrome-mcp-setup-guide.md`
2. Present the full guide to the user
3. End with: "After completing the setup, re-run `/iterate --cross`."

### Open Google Ads MCC

1. Use Chrome MCP to navigate to `https://ads.google.com`
2. Verify login state -- if a login prompt is shown, tell the user:
   > "Please log into Google Ads in Chrome, then re-run `/iterate --cross`."
   > STOP.
3. Confirm this is an MCC (Manager Account) -- the page should show multiple sub-accounts. If it's a single account, STOP:
   > "Cross-MVP evaluation requires an MCC (Manager Account) with multiple sub-accounts. You appear to be in a single account. Switch to your MCC, then re-run `/iterate --cross`."

### List campaigns across sub-accounts

1. Navigate to **All campaigns** view at the MCC level (or each sub-account's Campaigns page)
2. For each sub-account, extract all campaigns:
   - Campaign name
   - Final URL (landing page URL) -- from the campaign's Ads tab or Settings
   - Status (Active / Paused / Ended)
   - Start date and end date (if available)
   - Total spend (if visible at this level)
   - **Sub-account name** (e.g., "Lee MVP", "Lego's MVP Account") and **sub-account ID** (the 10-digit ocid)
   - **Owner** — derive from the sub-account name. Convention: lowercase first word, strip "MVP"/"Account"/"'s" tokens. Examples: "Lee MVP" → `lee`; "Lego's MVP Account" → `lego`; "Radlin's MVP Account" → `radlin`; "Lew's MVP Account" → `lew`. If ambiguous, ask the Team Lead.
3. Compile a full list of campaigns across all sub-accounts

### Filter eligible campaigns

Only keep campaigns that meet these criteria:
- Status is **Ended**, OR
- Campaign has been running for **>= 7 days** (based on start date)

Exclude:
- Campaigns still running with < 7 days elapsed
- Campaigns with no Final URL (cannot match to an MVP)

### Extract MVP identifiers

For each eligible campaign:
- Parse the Final URL to extract the domain (e.g., `https://pettracker.vercel.app/` → `pettracker.vercel.app`)
- Use the domain as the MVP identifier
- If multiple campaigns share the same domain, group them under one MVP (sum metrics later)

### Confirm with Team Lead

Present the discovered MVPs:
> "Found **N** eligible MVPs from Google Ads MCC:
>
> | # | Owner | MVP | Domain | Campaign | Status | Days Running |
> |---|-------|-----|--------|----------|--------|-------------|
> | 1 | {owner} | {name} | {domain} | {campaign_name} | {status} | {days} |
> | ... |
>
> Proceed with evaluation of all N MVPs?"

Wait for Team Lead confirmation. If they want to exclude or add MVPs, adjust the list accordingly.

### Merge cross-specific fields into context

```bash
# Write extra JSON to temp file (avoids shell quoting issues with campaign names)
python3 -c "
import json

mvps = [
    # Populate from discovered data:
    # {'name': 'pettracker', 'owner': 'lee', 'subaccount_name': 'Lee MVP', 'subaccount_id': '896-346-8125', 'domain': 'pettracker.vercel.app', 'campaign_name': '...', 'campaign_id': '...', 'status': '...', 'days_running': 7, 'final_url': 'https://...'}
]

extra = {
    'mode': 'cross',
    'mvp_count': len(mvps),
    'mvps': mvps,
    'completed_states': ['x0']
}
json.dump(extra, open('.runs/_iterate-cross-extra.json', 'w'))
"
bash .claude/scripts/init-context.sh iterate-cross "@.runs/_iterate-cross-extra.json"
rm -f .runs/_iterate-cross-extra.json
```

Replace the `mvps` list with actual data collected from Chrome MCP. The base fields (`skill`, `branch`, `timestamp`, `run_id`) are already set by lifecycle-init.sh.

**POSTCONDITIONS:**
- Chrome MCP tools verified available
- MCC dashboard accessed, campaigns listed
- Eligible MVPs filtered (Ended or >= 7 days)
- Team Lead confirmed the MVP list
- `.runs/iterate-cross-context.json` exists with MVP list — every MVP has `owner`, `subaccount_name`, `subaccount_id`

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x0`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-context.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m.get('name','?') for m in ms if not m.get('owner') or not m.get('subaccount_name')]; assert not bad, 'MVPs missing owner/subaccount_name: %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue. (After x1 gathers data, [state-x1a-validate-data-integrity.md](state-x1a-validate-data-integrity.md) validates it before x2.)
