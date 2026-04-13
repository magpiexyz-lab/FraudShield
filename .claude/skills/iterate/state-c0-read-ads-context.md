# STATE c0: READ_ADS_CONTEXT

**PRECONDITIONS:**
- Git repository exists in working directory

**ACTIONS:**

### Validate ads configuration

1. Verify `experiment/ads.yaml` exists. If not, STOP:
   > "No ads config found. Run `/distribute` first to generate `experiment/ads.yaml`, then run `/iterate --check`."

2. Read `experiment/ads.yaml`. Extract:
   - `channel` (e.g., `google-ads`)
   - `campaign_name`
   - `landing_url`
   - `campaign_id` (if present)
   - `budget.total_budget_cents`, `budget.daily_budget_cents`, `budget.duration_days`
   - `guardrails.max_cpc_cents`
   - `thresholds` (all fields)

3. If `channel` is not `google-ads`, STOP:
   > "The `--check` mode currently supports Google Ads only. Your ads.yaml uses channel `{channel}`. Manual health checks are needed for this channel."

4. If `campaign_id` is absent from ads.yaml, STOP:
   > "No `campaign_id` in ads.yaml -- campaign not yet created. Complete `/distribute` STATE 9 to create the campaign, then run `/iterate --check`."

5. Read `experiment/experiment.yaml`. Extract `name` and `type` (archetype, default `web-app`).

### Compute campaign age

Calculate `campaign_age_days`:
- If `.runs/distribute-context.json` exists, read its `timestamp` field and compute days elapsed from that date to today. Also read its `phase` field (1 or 2) to pass to the context file
- Otherwise, ask the user: "When did you launch the campaign? (provide date or number of days ago)"

### Verify Chrome MCP availability

Use ToolSearch to check for Chrome MCP tools:
```
ToolSearch: query="claude-in-chrome", max_results=5
```

If no `mcp__claude-in-chrome__*` tools are returned, STOP and show the setup guide:

1. Read `.claude/patterns/chrome-mcp-setup-guide.md`
2. Present the full guide to the user
3. End with: "After completing the setup, re-run `/iterate --check`."

### Merge ads-specific fields into context

```bash
bash .claude/scripts/init-context.sh iterate-check "{\"mode\":\"check\",\"channel\":\"<channel from ads.yaml>\",\"campaign_name\":\"<campaign_name>\",\"campaign_id\":\"<campaign_id>\",\"campaign_age_days\":<N>,\"phase\":<1 or 2 from distribute-context.json, or null if unavailable>,\"budget_total_cents\":<N>,\"budget_daily_cents\":<N>,\"max_cpc_cents\":<N>,\"completed_states\":[\"c0\"]}"
```

Replace all `<placeholder>` values with actual data read from ads.yaml and experiment.yaml. The base fields (`skill`, `branch`, `timestamp`, `run_id`) are already set by lifecycle-init.sh. The `completed_states:["c0"]` override replaces the default `[0]` to use iterate-check's string state IDs.

**POSTCONDITIONS:**
- `experiment/ads.yaml` read, channel is `google-ads`, `campaign_id` exists
- Campaign age computed
- Chrome MCP tools verified available via ToolSearch
- `.runs/iterate-check-context.json` exists

**VERIFY:**
```bash
test -f .runs/iterate-check-context.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-check c0
```

**NEXT:** Read [state-c1-check-health.md](state-c1-check-health.md) to continue.
