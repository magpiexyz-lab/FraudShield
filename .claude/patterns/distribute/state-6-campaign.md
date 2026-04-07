# STATE 6: CAMPAIGN

**PRECONDITIONS:**
- PR opened (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

After opening the PR, create the ad campaign via Chrome MCP.
Campaign metadata (`campaign_id`, `campaign_url`) is committed to the feature branch and included in the PR.

### 6a: Check for existing campaign

1. If `experiment/ads.yaml` has a `campaign_id` field → campaign already created (idempotent), skip to **6i**
2. If not → proceed to **6b**

### 6b: Verify Chrome MCP availability

Use ToolSearch to check for Chrome MCP tools:
```
ToolSearch: query="claude-in-chrome", max_results=5
```

If no `mcp__claude-in-chrome__*` tools are returned, STOP and show the setup guide:

1. Read `.claude/patterns/chrome-mcp-setup-guide.md`
2. Present the full guide to the user
3. End with: "After completing the setup (including restarting Claude Code to load the tools), re-run `/distribute` — it will pick up where it left off."

> **Note:** `/chrome` → "Enable by default" saves the setting but does NOT load tools into the current session. The user must exit and start a new Claude Code session for the tools to appear.

### 6c: Verify Google Ads login

1. Use Chrome MCP to navigate to `https://ads.google.com`
2. If a login prompt is shown, tell the user:
   > "Please log into Google Ads in Chrome with the account that has access to your team's MCC, then re-run `/distribute`."
   > STOP.
3. Verify the user is in their sub-account (not the MCC top level):
   - If at MCC level, tell the user to navigate to their sub-account first

### 6d: Campaign approval gate (Phase 2 / non-google-ads only)

Read `phase` from `.runs/distribute-context.json`. Read `channel` from `experiment/ads.yaml`.

If phase is 1 AND channel is `google-ads`:
- Skip this step. Log: "Phase 1 Playbook: standardized campaign settings — skipping campaign approval gate."
- Proceed directly to **6e**.

If phase is 2, or channel is not `google-ads`:
- **STOP.** Show a campaign creation preview:

> **Ready to create campaign via Chrome**
> - **Channel:** {channel}
> - **Campaign name:** {campaign_name}
> - **Budget:** ${total_budget_cents / 100} over {duration_days} days (${daily_budget_cents / 100}/day)
> - **Bidding:** Manual CPC, max ${max_cpc_cents / 100}
> - **Keywords:** {keyword count} keywords (Phrase Match)
> - **Ads:** {number of RSAs} Responsive Search Ads
> - **Geo:** {target_geo}
> - **Status:** Campaign will be created in **PAUSED** status
>
> Reply **approve** to proceed, or tell me what to change.

**Do not proceed until the user approves.** If the user requests changes, revise `experiment/ads.yaml` and present the preview again.

### 6e: Create campaign via Chrome MCP

Read all settings from `experiment/ads.yaml`. Then execute the following steps via Chrome MCP, interacting with the Google Ads UI:

**Step 0: Ensure Conversion Action exists**

Before creating the campaign, verify the sub-account has the required conversion action for offline import:

1. Navigate to **Tools & Settings** (wrench icon) → **Measurement** → **Conversions** via Chrome MCP
2. Scan the conversion actions list for one named `MVP Signup`
3. **If found:** Log "Conversion action 'MVP Signup' already exists — skipping creation" → proceed to Step 1
4. **If not found:** Create it:
   - Click "+ New conversion action"
   - Select **Import** → "Other data sources or CRMs" → "Track conversions from clicks"
   - Conversion name: `MVP Signup`
   - Category: **Lead** → **Sign-up**
   - Value: "Don't use a value"
   - Count: **One** (one conversion per click — prevents duplicate counting)
   - Click-through conversion window: 30 days
   - Click "Create and Continue", then "Done"
5. Verify the new action appears in the conversions list
6. Log: "Created 'MVP Signup' conversion action"

This step is idempotent — on re-runs, Step 0 checks first and skips if the action exists. The action is per sub-account (not per campaign) because Google Ads uses the gclid to auto-attribute conversions to the correct campaign.

**Step 1: Start new campaign**
- Click "+ New campaign" button
- Select "Create a campaign without a goal's guidance" (to avoid Smart Campaign defaults)
- Select campaign type: **Search**
- Click Continue

**Step 2: Campaign settings**
- Campaign name: `{campaign_name}` from ads.yaml
- Networks: **Uncheck** "Include Google search partners" and "Include Google Display Network"
- Locations: Enter each country from `target_geo` in ads.yaml (e.g., United States, United Kingdom, Canada, Australia, New Zealand)
- Location options: Select "Presence: People in or regularly in your targeted locations"
- Languages: English
- Budget: Set daily budget to `${daily_budget_cents / 100}`
- Bidding: Select "Manual CPC" — uncheck "Help increase conversions with Enhanced CPC"
- Set default max CPC bid to `${max_cpc_cents / 100}`

**Step 3: Ad group**
- Ad group name: `{campaign_name}-ag1`
- Add all keywords from ads.yaml `keywords.phrase` list (one per line, each wrapped in quotes for Phrase Match: `"keyword here"`)

**Step 4: Create RSAs**
- For each RSA defined in ads.yaml `creatives` section:
  - Add headlines (H1-H8+): paste from ads.yaml
  - Pin H1 to Position 1, Pin H2 to Position 2
  - Add descriptions (D1-D4): paste from ads.yaml
  - Click "Done"
- Repeat for second RSA if defined

**Step 5: Add negative keywords**
- Navigate to Keywords → Negative keywords
- Click "+" to add
- Add all terms from ads.yaml `negative_keywords` list (one per line)
- Save at campaign level

**Step 6: Review and create**
- Review the campaign summary page
- **Do NOT click "Publish" yet** — the campaign must be in PAUSED status
- Click "Create campaign" or "Save" (campaign is created as paused/draft)
- If Google Ads auto-enables it, immediately pause it

**Step 7: Record campaign metadata**
- From the campaign dashboard, read the campaign ID (visible in the URL: `campaignId=XXXXXXXXXX`)
- Record the campaign URL (the dashboard URL for this campaign)
- Add to `experiment/ads.yaml`:
  ```yaml
  campaign_id: "<campaign_id>"
  campaign_url: "<dashboard_url>"
  ```

**Step 7.5: Capture and upload Image Assets**

Google Search ads support optional Image Assets displayed alongside the text ad. This step captures high-quality product screenshots and uploads them.

**Skip conditions** (check first):
- If `image_assets_uploaded: true` already in ads.yaml → skip (idempotent)
- If user says "skip images" → skip, record `image_assets_uploaded: skipped` in ads.yaml

**7.5a: Open MVP landing page**
1. Use Chrome MCP to navigate to `deploy.url` from experiment.yaml (open in a new tab, keep the Google Ads tab)
2. Wait for full page load — confirm no skeleton screens, no loading spinners, all images rendered
3. Dismiss any cookie banners, chat widgets, or popups via Chrome MCP clicks

**7.5b: Set viewport for high-res capture**
1. Execute JavaScript via Chrome MCP to set viewport width to 1200px:
   `document.documentElement.style.width = '1200px'`
   or resize the browser window to 1200px wide
2. This ensures the screenshot matches Google Ads landscape spec without upscaling

**7.5c: Capture Landscape image (1200x628)**
1. Scroll to the top of the page (hero section)
2. Take a full-width screenshot via Chrome MCP
3. Use Bash to crop to exact dimensions:
   ```bash
   convert /tmp/screenshot-hero.png -gravity North -crop 1200x628+0+0 +repage /tmp/ad-image-landscape.png
   ```
4. If imagemagick is not installed: use Python Pillow as fallback:
   ```bash
   python3 -c "from PIL import Image; img=Image.open('/tmp/screenshot-hero.png'); img.crop((0,0,1200,628)).save('/tmp/ad-image-landscape.png')"
   ```

**7.5d: Capture Square image (1200x1200)**
1. Scroll down to the product UI / feature showcase section (typically below the hero fold)
2. Take a screenshot
3. Crop to 1200x1200:
   ```bash
   convert /tmp/screenshot-features.png -gravity Center -crop 1200x1200+0+0 +repage /tmp/ad-image-square.png
   ```

**7.5e: Show to user for approval**

**STOP.** Display both cropped images to the user:

> **Image Assets for your Google Ad:**
>
> **Landscape (1200x628):** [show /tmp/ad-image-landscape.png]
> **Square (1200x1200):** [show /tmp/ad-image-square.png]
>
> These will be uploaded as Image Assets alongside your text ad. Reply **approve** to upload, or tell me which section of the page to capture instead. Reply **skip** to skip image assets.

- If approved → continue to 7.5f
- If user wants different section → scroll to specified area, re-capture, re-show
- If user says skip → record `image_assets_uploaded: skipped` in ads.yaml, skip to 6f

**7.5f: Upload to Google Ads**
1. Switch back to the Google Ads tab
2. Navigate to the campaign → **Ads & assets** → **Assets**
3. Click **"+"** → Select **"Image"**
4. Upload the landscape image (`/tmp/ad-image-landscape.png`)
5. Upload the square image (`/tmp/ad-image-square.png`)
6. Save
7. If upload fails (file too large, format rejected): resize to 80% quality JPEG and retry:
   ```bash
   convert /tmp/ad-image-landscape.png -quality 80 /tmp/ad-image-landscape.jpg
   ```

**7.5g: Record in ads.yaml**
- Add `image_assets_uploaded: true` to `experiment/ads.yaml`
- Commit and push (updates the open PR)

**On failure at any step:**
- Screenshot the error state
- Report to the user what went wrong and at which step
- Retry from the failed step (up to 2 retries per step)
- If still failing after retries: STOP and ask the user to resolve the issue in Chrome, then re-run `/distribute` (Step 6a idempotency check will skip already-completed work)

### 6f: Phase 1 launch protocol

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

### 6g: Commit campaign metadata and push

- Add `campaign_id` and `campaign_url` to `experiment/ads.yaml`
- Commit to the current feature branch and push (updates the open PR)

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

### 6h: Auto-merge

Follow `.claude/patterns/auto-merge.md`. The PR number is from State 5's `gh pr create` output (retrieve via `gh pr view --json number -q .number`).

If any safety gate fails, report the failure and include it in the 6i message. The user merges manually.

If auto-merge succeeds, prepend to the 6i message: "Distribution PR auto-merged to main."

### 6i: Next steps

Read `phase` from `.runs/distribute-context.json`.

**If phase is 1:**

> Your Phase 1 campaign is created in PAUSED mode. Follow the Day -2 / -1 / 0 protocol:
>
> **Day -2 (today):** Campaign created and paused. Ads are being reviewed by Google.
> **Day -1 (tomorrow):** Run `/iterate --check` to verify ad approval status. If any ads are disapproved, it will auto-fix them.
> **Day 0 ({recommended_unpause_date}):** Run `/iterate --check` — if all ads are approved, it will unpause the campaign automatically.
>
> **During Phase 1 (Days 1-5):**
> 1. Run `/iterate --check` on Days 1 and 3 to monitor campaign performance.
> 2. It will automatically fix issues: add negative keywords, raise CPC if zero impressions, etc.
> 3. Do NOT change bidding strategy during Phase 1 — stay on Manual CPC.
>
> **After Phase 1:**
> Your Team Lead will run `/iterate --cross` to compare all MVPs and decide which advance to Phase 2.

**If phase is 2 (or no phase):**

> Your distribution campaign is ready. Next steps:
> 1. **Enable the campaign** — it was created in PAUSED status. After verifying conversion tracking, enable it in the ad platform dashboard.
> 2. **Verify conversion tracking** by clicking your own ad and completing the activation flow.
> 3. **Monitor performance** — after a few days, run `/iterate` to analyze metrics.
> 4. **After `/iterate` feedback** — if changes recommended, run `/change`. Campaign can keep running during changes.

### Completion checkpoint

Write `.runs/distribute-step-check.json`:
```bash
python3 -c "
import json, os, subprocess
steps = ['6a']  # idempotency check always runs
ads = {}
if os.path.exists('experiment/ads.yaml'):
    import yaml
    ads = yaml.safe_load(open('experiment/ads.yaml')) or {}
if ads.get('campaign_id'):
    steps.extend(['6b','6c','6d','6e','6f','6g'])
pr = subprocess.run(['gh','pr','view','--json','number'], capture_output=True, text=True)
if pr.returncode == 0:
    steps.append('6h')
if os.path.exists('.runs/q-score-distribute.json'):
    steps.append('q_score')
steps.append('6i')
os.makedirs('.runs', exist_ok=True)
json.dump({
    'steps_completed': steps,
    'key_outputs': {
        'campaign_id': str(ads.get('campaign_id', '')),
        'image_assets_uploaded': str(ads.get('image_assets_uploaded', 'false')),
        'phase': json.load(open('.runs/distribute-context.json')).get('phase', 0) if os.path.exists('.runs/distribute-context.json') else 0
    }
}, open('.runs/distribute-step-check.json', 'w'), indent=2)
print('SELF-CHECK: wrote .runs/distribute-step-check.json with', len(steps), 'steps')
"
```

This checkpoint is mandatory. Do not skip it.

**POSTCONDITIONS:**
- Campaign created via Chrome MCP with campaign_id/campaign_url in ads.yaml, OR existing campaign detected and skipped
- PR auto-merged to main (or intentionally skipped with reason)
- `.runs/distribute-step-check.json` exists with at least 1 completed step

**VERIFY:**
```bash
(grep -q 'campaign_id' experiment/ads.yaml 2>/dev/null || grep -q 'manual_creation' experiment/ads.yaml 2>/dev/null || test -f experiment/ads.yaml) && python3 -c "import json; d=json.load(open('.runs/distribute-step-check.json')); assert len(d.get('steps_completed',[])) > 0"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 6
```

**NEXT:** TERMINAL — campaign is ready, PR auto-merged (or left open with reason). Follow the next steps in 6i.
