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

### 9d-pre: Phase 1 approval gate bypass check

Read `phase` from `.runs/distribute-context.json`. Read `channel` from `experiment/ads.yaml`.

If phase is 1 AND channel is `google-ads`:
- The Phase 1 Playbook uses standardized settings that have been pre-validated. The config approval at Step 6 already covered the AI-generated content (keywords, ad copy).
- Skip the Step 9d approval gate and proceed directly to **9e**.
- Log: "Phase 1 Playbook: standardized campaign settings — skipping 9d approval gate (settings pre-validated by Playbook)."

If phase is 2, or channel is not `google-ads`, proceed to 9d as normal.

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

**Do not proceed until the user approves.** This is a second approval gate — Step 6 approves the config, Step 9d approves actual campaign creation with real credentials. If the user requests changes instead of approving, revise the campaign preview to address their feedback (adjust budget, targeting, ad count, etc. in `experiment/ads.yaml`) and present the preview again. Repeat until approved.

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

### 9e-2: Phase 1 launch protocol

Read `phase` from `.runs/distribute-context.json`. If phase is 1:

1. Campaign was created in PAUSED status (standard).
2. Compute the recommended unpause date (48 hours from campaign creation):
   ```bash
   UNPAUSE_DATE=$(python3 -c "
   from datetime import datetime, timedelta
   unpause = datetime.utcnow() + timedelta(hours=48)
   print(unpause.strftime('%Y-%m-%d %H:%M UTC'))
   ")
   echo "Recommended unpause: $UNPAUSE_DATE"
   ```
3. Add `launch_protocol` to `experiment/ads.yaml`:
   ```yaml
   launch_protocol:
     created_paused: true
     recommended_unpause: "<YYYY-MM-DD HH:MM UTC>"
     pre_launch_checklist:
       - "Check ad approval status (24-48h after creation)"
       - "Verify conversion tracking with test click"
       - "Confirm PageSpeed >= 70 mobile"
   ```
4. Commit the updated `experiment/ads.yaml` to the current feature branch and push (updates the open PR).

If phase is not 1, skip this step.

### 9f: Manual fallback

Only reached when:
- (a) The channel's stack file has no "API Campaign Creation" section (e.g., reddit), or
- (b) The API call in **9e** failed

> Create the campaign manually using the config in `experiment/ads.yaml`.
> See the channel's stack file "Setup Instructions" section for step-by-step guidance.
> The PR from Step 8 is ready to merge — it contains the distribution code (UTM capture, feedback widget, ads.yaml) independent of campaign creation. Merge it now, then create the campaign manually.
>
> **After creating the campaign:** add `campaign_id: <id>` and `campaign_url: <dashboard-url>` to `experiment/ads.yaml`. To commit: create a new branch (`git checkout main && git checkout -b chore/add-campaign-id`), commit the update, and open a PR — do not commit directly to main. This enables idempotency (Step 9b) if `/distribute` is re-run, and provides a reference for `/iterate`. Then follow the next steps in **9g** below.

### Q-score

Compute distribute execution quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/distribute-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
CAMPAIGN_CREATED=$(grep -q 'campaign_id' experiment/ads.yaml 2>/dev/null && echo "1.0" || echo "0.5")
python3 .claude/scripts/write-q-score.py \
  --skill distribute --scope distribute \
  --archetype "$(python3 -c "import yaml; print(yaml.safe_load(open('experiment/experiment.yaml')).get('type','web-app'))" 2>/dev/null || echo web-app)" \
  --gate 1.0 --dims "{\"campaign\": $CAMPAIGN_CREATED, \"completion\": 1.0}" \
  --run-id "$RUN_ID" || true
```

### 9g: Next steps

Read `phase` from `.runs/distribute-context.json`.

**If phase is 1:**

> Your Phase 1 campaign is created in PAUSED mode. Follow the Day -2 / -1 / 0 protocol:
>
> **Day -2 (today):** Campaign created and paused. Ads are being reviewed by Google.
> **Day -1 (tomorrow):** Check ad approval status in Google Ads dashboard. If any ads are disapproved, fix and resubmit.
> **Day 0 ({recommended_unpause_date from launch_protocol}):** If all ads are approved and conversion tracking is verified, enable the campaign in the dashboard.
>
> **During Phase 1 (Days 1-7):**
> 1. Run `/iterate --check` on Days 1, 3, and 5 to monitor campaign performance.
> 2. Check the Search Terms Report on Day 3 and Day 7 — add irrelevant terms to negative keywords.
> 3. If any keyword gets zero impressions after 48 hours, switch it to Broad Match.
> 4. Do NOT change bidding strategy during Phase 1 — stay on Manual CPC.
>
> **After Phase 1:**
> Run `/iterate` to analyze 7-day performance and decide: continue as-is, adjust, or run `/distribute --phase 2` for an extended campaign.

**If phase is 2 (or no phase):**

> Your distribution campaign is ready. Next steps:
> 1. **Enable the campaign** — it was created in PAUSED status. After verifying conversion tracking, enable it in the ad platform dashboard.
> 2. **Verify conversion tracking** by clicking your own ad and completing the activation flow — confirm the event appears in your analytics dashboard.
> 3. **Monitor performance** — after the campaign runs for a few days, run `/iterate` to analyze your metrics and decide what to change next.
> 4. **After `/iterate` feedback** — if `/iterate` recommends changes (e.g., improve landing page, reduce activation friction), run `/change` with the specific improvement. The campaign can keep running during changes — new visitors will see the updated page after you merge and deploy. If `/iterate` recommends revising targeting or budget, pause the campaign in the ad platform dashboard, update `experiment/ads.yaml`, re-run `/distribute`, then enable the new campaign.

### 9h: Auto-merge

Follow `.claude/patterns/auto-merge.md`. The PR number is from state-8's
`gh pr create` output (retrieve via `gh pr view --json number -q .number`).

If the manual fallback path (9f) was taken AND the user has not yet merged:
proceed with auto-merge — the PR contains the distribution code independent
of campaign creation.

If any safety gate fails, report the failure and include it in the 9g next
steps message. The user merges manually.

If auto-merge succeeds, prepend to the 9g message: "Distribution PR auto-merged
to main."

**POSTCONDITIONS:**
- Campaign created via API (9e) with campaign_id/campaign_url added to ads.yaml, OR
- Manual fallback instructions provided (9f), OR
- Existing campaign detected (9b) and skipped to next steps (9g)
- PR auto-merged to main (or intentionally skipped with reason)

**VERIFY:**
```bash
grep -q 'campaign_id' experiment/ads.yaml 2>/dev/null || grep -q 'manual_creation' experiment/ads.yaml 2>/dev/null || test -f experiment/ads.yaml
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 9
```

**NEXT:** TERMINAL — campaign is ready, PR auto-merged (or left open with reason). Follow the next steps in 9g.
