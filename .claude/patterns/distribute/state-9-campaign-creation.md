# STATE 9: CAMPAIGN_CREATION

**PRECONDITIONS:**
- PR opened (STATE 8 POSTCONDITIONS met)

**ACTIONS:**

After opening the PR, attempt automated campaign creation if the channel supports it.
Campaign metadata (`campaign_id`, `campaign_url`) is committed to the feature branch and included in the PR.

### 9a: Check API support

1. Read `channel` from `experiment/ads.yaml`
2. Read the channel's stack file at `.claude/stacks/distribution/<channel>.md`
3. If the stack file contains an "API Campaign Creation" section → proceed to **9b**
4. If not (e.g., reddit) → skip to **9f** (manual fallback)

### 9b: Check for existing campaign

1. If `experiment/ads.yaml` has a `campaign_id` field → campaign already created (idempotent), skip to **9g**
2. If not → proceed to **9c**

### 9c: Check credentials

1. Read the "Credential Files" subsection from the channel's "API Campaign Creation" section
2. For each credential file listed, check if it exists: `test -f <path>`
3. If **ALL** files exist → proceed to **9d**
4. If **ANY** are missing → guide the user through credential setup:
   1. Show which credential files are missing
   2. Read the "Setup" subsection from the channel's "API Campaign Creation" section
   3. Walk the user through each setup step interactively
   4. As each credential is provided, save it: `mkdir -p <dir> && echo "$VALUE" > <path>`
   5. After all credentials are saved → proceed to **9d**
   6. If the user cannot set up credentials now, offer: "Type **skip** to skip campaign creation. You can create the campaign manually after merging the PR — see the channel's stack file 'Setup Instructions'. Or re-run `/distribute` later — Step 9b checks for `campaign_id` and picks up where you left off." If skipped, jump to Step 9f (manual fallback).

### 9d: STOP for approval

**STOP.** Show a campaign creation preview:

> **Ready to create campaign via API**
> - **Channel:** {channel}
> - **Campaign name:** {campaign_name}
> - **Budget:** ${total_budget_cents / 100} over {duration_days} days
> - **Targeting summary:** {keyword count or audience summary}
> - **Ad count:** {number of ads/tweets}
> - **Status:** Campaign will be created in **PAUSED** status (you enable it after verifying tracking)
>
> This will use real ad platform credentials. Reply **approve** to create the campaign, or tell me what to change.

**Do not proceed until the user approves.** This is a second approval gate — Step 6 approves the config, Step 9d approves actual campaign creation with real credentials.

### 9e: Create campaign via API

1. Read the "API Procedure" subsection from the channel's "API Campaign Creation" section
2. Follow the procedure step-by-step, using the credentials from **9c** and the config from `experiment/ads.yaml`
3. Campaign is created in **PAUSED** status (safety — user enables after verifying tracking)
4. On success:
   - Extract the campaign ID and dashboard URL from the response (see "Response Handling" subsection)
   - Add `campaign_id: <id>` and `campaign_url: <url>` to `experiment/ads.yaml`
   - Commit the updated `experiment/ads.yaml` to the current feature branch and push (updates the open PR)
5. On failure:
   - Read the "Error Handling" subsection for guidance on the specific error
   - Report the error to the user
   - Fall through to **9f**

### 9f: Manual fallback

Only reached when:
- (a) The channel's stack file has no "API Campaign Creation" section (e.g., reddit), or
- (b) The API call in **9e** failed

> Create the campaign manually using the config in `experiment/ads.yaml`.
> See the channel's stack file "Setup Instructions" section for step-by-step guidance.
> The PR from Step 8 is ready to merge — it contains the distribution code (UTM capture, feedback widget, ads.yaml) independent of campaign creation. Merge it now, then create the campaign manually.

### Q-score

Compute distribute execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.claude/distribute-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
CAMPAIGN_CREATED=$(grep -q 'campaign_id' experiment/ads.yaml 2>/dev/null && echo "1.0" || echo "0.5")
python3 .claude/scripts/write-q-score.py \
  --skill distribute --scope distribute \
  --archetype "$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('type','web-app'))" 2>/dev/null || echo web-app)" \
  --gate 1.0 --dims "{\"campaign\": $CAMPAIGN_CREATED, \"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

### 9g: Next steps

> Your distribution campaign is ready. Next steps:
> 1. **Enable the campaign** — it was created in PAUSED status. After verifying conversion tracking, enable it in the ad platform dashboard.
> 2. **Verify conversion tracking** by clicking your own ad and completing the activation flow — confirm the event appears in your analytics dashboard.
> 3. **Monitor performance** — after the campaign runs for a few days, run `/iterate` to analyze your metrics and decide what to change next.
> 4. **After `/iterate` feedback** — if `/iterate` recommends changes (e.g., improve landing page, reduce activation friction), run `/change` with the specific improvement. The campaign can keep running during changes — new visitors will see the updated page after you merge and deploy. If `/iterate` recommends revising targeting or budget, pause the campaign in the ad platform dashboard, update `experiment/ads.yaml`, re-run `/distribute`, then enable the new campaign.

**POSTCONDITIONS:**
- Campaign created via API (9e) with campaign_id/campaign_url added to ads.yaml, OR
- Manual fallback instructions provided (9f), OR
- Existing campaign detected (9b) and skipped to next steps (9g)

**VERIFY:**
```bash
grep -q 'campaign_id' experiment/ads.yaml 2>/dev/null || grep -q 'manual_creation' experiment/ads.yaml 2>/dev/null || test -f experiment/ads.yaml
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 9
```

**NEXT:** TERMINAL -- campaign is ready. Follow the next steps in 9g.
