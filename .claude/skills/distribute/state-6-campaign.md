# STATE 6: CAMPAIGN

**PRECONDITIONS:**
- PR opened (STATE 5 POSTCONDITIONS met)

**ACTIONS:**

After opening the PR, create the ad campaign via Chrome MCP.
Campaign metadata (`campaign_id`, `campaign_url`) is committed to the feature branch and included in the PR.

### 6a: Check for existing campaign

1. If `experiment/ads.yaml` has a `campaign_id` field → campaign already created (idempotent), skip to **6j**
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

**Initialize evidence file** before starting any steps:

```bash
python3 -c "
import json, os, datetime
os.makedirs('.runs', exist_ok=True)
json.dump({'entries': [], 'initialized_at': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')}, open('.runs/distribute-campaign-evidence.json', 'w'), indent=2)
print('Evidence file initialized')
"
```

After completing each sub-step below, record what you observed on the page by running:

```bash
python3 -c "
import json, datetime
f = '.runs/distribute-campaign-evidence.json'
data = json.load(open(f))
data['entries'].append({
    'step': '<STEP_KEY>',
    'action': '<what you did>',
    'evidence': '<what you literally observed on the page>',
    'timestamp': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
})
json.dump(data, open(f, 'w'), indent=2)
"
```

Replace `<STEP_KEY>`, `<action>`, and `<evidence>` with the actual values for each sub-step. The `> **Record evidence:**` callouts below specify the key and expected content.

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

> **Record evidence:** step=`conversion_action`, action="Checked/created conversion action", evidence="<what you saw: e.g., 'MVP Signup conversion action found in list' or 'Created MVP Signup conversion action, verified it appears in list'>"

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

> **Record evidence (2 entries):**
> - step=`campaign_settings`, action="Set bidding to Manual CPC, disabled Enhanced CPC", evidence="<what you saw: e.g., 'Bidding section shows Manual CPC selected, Enhanced CPC checkbox unchecked, max CPC set to $X.XX'>"
> - step=`network_settings`, action="Unchecked Search Partners and Display Network", evidence="<what you saw: e.g., 'Networks section shows only Google Search checked, Search partners unchecked, Display Network unchecked'>"

**Step 3: Ad group**
- Ad group name: `{campaign_name}-ag1`
- Add all keywords from ads.yaml `keywords.phrase` list (one per line, each wrapped in quotes for Phrase Match: `"keyword here"`)

> **Record evidence:** step=`keywords`, action="Added keywords from ads.yaml", evidence="<what you saw: e.g., 'Added 8 keywords in phrase match, keyword list shows: invoice for freelancers, get paid faster freelancer, ...'>" Include the count and match type.

**Step 4: Create RSAs**
- For each RSA defined in ads.yaml `creatives` section:
  - Add headlines (H1-H8+): paste from ads.yaml
  - Pin H1 to Position 1, Pin H2 to Position 2
  - Add descriptions (D1-D4): paste from ads.yaml
  - Click "Done"
- Repeat for second RSA if defined

> **Record evidence (2 entries):**
> - step=`rsa_1`, action="Created first RSA", evidence="<what you saw: e.g., 'RSA 1 created with 5 headlines (H1 pinned pos 1, H2 pinned pos 2), 2 descriptions, ad saved'>"
> - step=`rsa_2`, action="Created second RSA", evidence="<what you saw: e.g., 'RSA 2 created with 5 headlines (H1 pinned pos 1, H2 pinned pos 2), 2 descriptions, ad saved'>" If only 1 RSA was defined in ads.yaml, record step=`rsa_2` with evidence="Only 1 RSA defined in ads.yaml, skipped".

**Step 5: Add negative keywords**
- Navigate to Keywords → Negative keywords
- Click "+" to add
- Add all terms from ads.yaml `negative_keywords` list (one per line)
- Save at campaign level

> **Record evidence:** step=`negative_keywords`, action="Added negative keywords", evidence="<what you saw: e.g., 'Added 52 negative keywords at campaign level, list includes: enterprise invoicing, accounting software, ...'>" Include the count.

**Step 6: Review and create**
- Review the campaign summary page
- **Do NOT click "Publish" yet** — the campaign must be in PAUSED status
- Click "Create campaign" or "Save" (campaign is created as paused/draft)
- If Google Ads auto-enables it, immediately pause it

> **Record evidence:** step=`campaign_status`, action="Verified campaign is paused", evidence="<what you saw: e.g., 'Campaign status shows Paused on dashboard, confirmed not auto-enabled'>"

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

**Step 7.6: Create Sitelink Extensions**

**Skip condition:** If ads.yaml `sitelinks` is an empty array, missing, or null, skip this step. Record evidence: step=`sitelink_assets`, action="Skipped -- no sitelinks in ads.yaml", evidence="sitelinks array empty or absent".

**Idempotency:** If ads.yaml has `sitelink_assets_uploaded: true`, skip this step.

For each sitelink in ads.yaml `sitelinks` array:

1. Navigate to the campaign → **Ads & assets** → **Assets** tab
2. Click **"+"** → Select **"Sitelink"**
3. Enter fields from ads.yaml:
   - **Sitelink text**: `link_text`
   - **Description line 1**: `description_1`
   - **Description line 2**: `description_2`
   - **Final URL**: `final_url`
4. Click **Save**
5. Repeat for each sitelink entry

> **Record evidence:** step=`sitelink_assets`, action="Created {N} sitelink extensions", evidence="<what you literally observed: e.g., 'Created 3 sitelinks: Create an Invoice, Sign Up Free, View Pricing. All saved successfully in Assets tab.'>"

**On success:** Add `sitelink_assets_uploaded: true` to `experiment/ads.yaml`. Commit and push.

**On failure:** Retry up to 2 times per sitelink. If a sitelink fails after retries, skip it and record the failure in evidence. Continue with remaining sitelinks. A partial set (as long as >= 2 succeed) is acceptable. If fewer than 2 succeed, record evidence noting the failure but do not block campaign creation.

**On failure at any step:**
- Screenshot the error state
- Report to the user what went wrong and at which step
- Retry from the failed step (up to 2 retries per step)
- If still failing after retries: STOP and ask the user to resolve the issue in Chrome, then re-run `/distribute` (Step 6a idempotency check will skip already-completed work)

**Manual creation fallback:** If Chrome MCP fails completely (no MCP tools available, persistent crashes, or user prefers to create manually):

1. Tell the user:
   > Chrome MCP automation failed. You can create the campaign manually in Google Ads using the settings in `experiment/ads.yaml`.
   > After creating the campaign, provide me with:
   > - The campaign ID (from the URL: `campaignId=XXXXXXXXXX`)
   > - The campaign dashboard URL

2. When the user provides the campaign_id and URL:
   - Add to `experiment/ads.yaml`:
     ```yaml
     campaign_id: "<provided campaign_id>"
     campaign_url: "<provided dashboard_url>"
     manual_creation: true
     ```
   - Create a minimal evidence file:
     ```bash
     python3 -c "
     import json, datetime
     json.dump({
         'entries': [],
         'manual_creation': True,
         'initialized_at': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
         'reason': 'Chrome MCP automation failed, user created campaign manually'
     }, open('.runs/distribute-campaign-evidence.json', 'w'), indent=2)
     "
     ```
   - Proceed to **6j** (the manual_creation path will ask user to verbally confirm settings).

### 6j: Campaign audit

Read `.runs/distribute-campaign-evidence.json` and cross-check against `experiment/ads.yaml`.

**If `manual_creation: true` in ads.yaml:** Skip automated evidence checks. Instead, present the following confirmation checklist to the user:

> **Manual Campaign Audit -- please confirm each setting:**
> 1. Bidding strategy is Manual CPC (not Maximize Clicks or Smart)? (y/n)
> 2. Enhanced CPC is OFF? (y/n)
> 3. Networks: Search only (no Search Partners, no Display Network)? (y/n)
> 4. All keywords from ads.yaml are present with correct match type? (y/n)
> 5. Both RSAs are created with pinned headlines? (y/n)
> 6. Negative keywords are added at campaign level? (y/n)
> 7. Campaign status is PAUSED? (y/n)
> 8. Sitelinks created in campaign Assets tab (if ads.yaml has sitelinks)? (y/n/N/A)

Record all responses. Treat "N/A" on item 8 as a pass (no sitelinks configured). If any is "n": STOP and ask user to fix in Google Ads UI, then re-confirm. Write audit result:

```bash
python3 -c "
import json, datetime
# Set all_passed to False if any response was 'n'
audit = {
    'manual_creation': True,
    'all_passed': True,
    'checked_at': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'checks': [
        {'name': 'manual_confirmation', 'expected': 'all_yes', 'actual': 'all_yes', 'pass': True}
    ]
}
json.dump(audit, open('.runs/distribute-campaign-audit.json', 'w'), indent=2)
"
```

**If automated (not manual_creation):** Perform the following checks.

Read the evidence file:
```bash
python3 -c "
import json
evidence = json.load(open('.runs/distribute-campaign-evidence.json'))
entries = evidence.get('entries', [])
print(f'Evidence entries: {len(entries)}')
for e in entries:
    print(f'  {e[\"step\"]}: {e[\"evidence\"][:80]}')
"
```

#### Chrome MCP Read-Back Verification

**Skip if `manual_creation: true`** — manual path uses 6j's y/n checklist + 6k table instead.

After reading the evidence file, navigate to the live campaign in Google Ads via Chrome MCP and read back the actual saved settings. This catches discrepancies between what the agent set and what Google Ads actually saved (e.g., Google defaulting to Maximize Clicks despite selecting Manual CPC).

Use `campaign_url` from `experiment/ads.yaml` as the starting point.

**Wait-and-retry strategy:** After each navigation, call `mcp__claude-in-chrome__read_page` with `filter: "all"`. If the accessibility tree contains loading indicators (spinner elements, "Loading..." text, skeleton placeholders), wait 3 seconds via `mcp__claude-in-chrome__javascript_tool` (`await new Promise(r => setTimeout(r, 3000))`) and retry `read_page`. Max 3 retries per page. If still loading after 3 retries → mark that page as `inconclusive`.

**Page 1: Campaign Settings**

1. Navigate to campaign Settings page (click "Settings" in left nav or navigate via campaign_url)
2. Read the accessibility tree via `mcp__claude-in-chrome__read_page` with `filter: "all"`
3. Extract 4 settings:
   - **Bidding strategy**: Find Bidding section → combobox/listbox/dropdown selected value, or text following the "Bid strategy type" label. Expected: contains "Manual CPC" (not "Maximize clicks", not "Maximize conversions")
   - **Enhanced CPC**: Within the Bidding section, find checkbox labeled "Enhanced CPC" or "Help increase conversions with Enhanced CPC". Read its `checked` state. Expected: `false` (unchecked)
   - **Daily budget**: Find Budget section → read input or text value showing daily budget amount. Expected: matches `budget.daily_budget_cents / 100` from ads.yaml
   - **Networks**: Find Networks section → locate "Search partners" and "Display Network" checkbox elements. Read both `checked` states. Expected: both `false` (unchecked)

**Page 2: Ad Group**

1. Navigate to Ad groups tab → click into `{campaign_name}-ag1` (the ad group created in Step 3 of 6e)
2. Read the accessibility tree
3. Extract:
   - **Default max CPC**: Find "Default max. CPC" or "Max. CPC bid" input/text value. Expected: matches `guardrails.max_cpc_cents / 100` from ads.yaml

**Page 3: Keywords Tab**

1. Navigate to Keywords tab within the campaign
2. Read the accessibility tree
3. Extract:
   - **Keywords match type**: Read the "Match type" column for the listed keywords. Expected: all show "Phrase match"

**Fallback per element:** If `read_page` can't locate a target element via structural parsing, try `mcp__claude-in-chrome__find` with a natural language query (e.g., "bidding strategy dropdown", "Enhanced CPC checkbox"), then `mcp__claude-in-chrome__get_page_text` as last resort for substring search.

**If any Chrome MCP call fails** (tool error, tab closed, connection lost): stop the read-back, set `readback.status` to `"inconclusive"` with reason, and continue to the evidence-based checks below. Read-back failure does NOT block the audit — it degrades to requiring 6k human confirmation with a warning banner.

**Record read-back results** by running:

```bash
python3 -c "
import json, datetime
# Replace the values below with actual read-back results from Chrome MCP
readback = {
    'status': '<completed|inconclusive>',
    'inconclusive_reason': None,  # or string reason if inconclusive
    'completed_at': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'settings': {
        'bidding_strategy': {'expected': 'Manual CPC', 'actual': '<ACTUAL_VALUE>', 'pass': True},
        'enhanced_cpc': {'expected': False, 'actual': False, 'pass': True},
        'daily_budget': {'expected': '<EXPECTED>', 'actual': '<ACTUAL>', 'pass': True},
        'networks': {'expected': {'search_partners': False, 'display_network': False}, 'actual': {'search_partners': False, 'display_network': False}, 'pass': True},
        'max_cpc': {'expected': '<EXPECTED>', 'actual': '<ACTUAL>', 'pass': True},
        'keywords_match_type': {'expected': 'Phrase match', 'actual': '<ACTUAL>', 'pass': True}
    },
    'all_readback_passed': True  # or False, or None if inconclusive
}
json.dump(readback, open('.runs/distribute-campaign-readback-tmp.json', 'w'), indent=2)
print(f'Read-back: {readback[\"status\"]} — {sum(1 for s in readback[\"settings\"].values() if s.get(\"pass\"))} / {len(readback[\"settings\"])} settings verified')
"
```

> **Record evidence:** step=`readback_verification`, action="Read back campaign settings via Chrome MCP", evidence="<summary of all 6 settings read and their values, e.g., 'Read 3 pages: Settings (bidding=Manual CPC, eCPC=OFF, budget=$20.00, networks=Search only), Ad group (max CPC=$2.50), Keywords (all Phrase match). 6/6 settings match ads.yaml.'>"

**Required evidence checks (8 total, plus 6 readback checks when read-back completes):**

| # | Check Name | Evidence Key | Expected | Cross-check with ads.yaml |
|---|-----------|-------------|----------|--------------------------|
| 1 | conversion_action | `conversion_action` | non-empty evidence | -- |
| 2 | campaign_settings | `campaign_settings` | evidence mentions "Manual CPC" | `budget.bidding_strategy == manual_cpc` |
| 3 | network_settings | `network_settings` | evidence mentions "Search only" or unchecked Partners/Display | -- |
| 4 | keywords_count | `keywords` | evidence count > 0 | count matches `len(keywords.phrase)` from ads.yaml |
| 5 | rsa_1 | `rsa_1` | non-empty evidence | -- |
| 6 | rsa_2 | `rsa_2` | non-empty evidence | -- |
| 7 | negative_keywords | `negative_keywords` | evidence count > 0 | -- |
| 8 | campaign_status | `campaign_status` | evidence mentions "Paused" | -- |
| 9 | sitelink_assets (conditional) | `sitelink_assets` | non-empty evidence | Only checked when ads.yaml has non-empty `sitelinks` array |

Write the audit result:

```bash
python3 -c "
import json, datetime, re, yaml, os

evidence = json.load(open('.runs/distribute-campaign-evidence.json'))
entries = {e['step']: e for e in evidence.get('entries', [])}
ads = yaml.safe_load(open('experiment/ads.yaml')) or {}

required_keys = [
    'conversion_action', 'campaign_settings', 'network_settings',
    'keywords', 'rsa_1', 'rsa_2', 'negative_keywords', 'campaign_status'
]

checks = []

# Check: all 8 evidence entries exist with non-empty evidence
for key in required_keys:
    entry = entries.get(key, {})
    has_evidence = bool(entry.get('evidence', '').strip())
    checks.append({
        'name': f'evidence_exists_{key}',
        'expected': 'non-empty evidence',
        'actual': entry.get('evidence', '')[:120] if has_evidence else 'MISSING',
        'pass': has_evidence
    })

# Cross-check: keyword count
kw_entry = entries.get('keywords', {})
if kw_entry.get('evidence'):
    ads_kw_count = len(ads.get('keywords', {}).get('phrase', []))
    nums = re.findall(r'(\d+)\s*keyword', kw_entry['evidence'].lower())
    evidence_count = int(nums[0]) if nums else -1
    checks.append({
        'name': 'keywords_count_match',
        'expected': f'{ads_kw_count} keywords from ads.yaml',
        'actual': f'{evidence_count} keywords from evidence',
        'pass': evidence_count == ads_kw_count or evidence_count == -1
    })

# Cross-check: bidding strategy
cs_entry = entries.get('campaign_settings', {})
if cs_entry.get('evidence'):
    expects_manual = ads.get('budget', {}).get('bidding_strategy', '') == 'manual_cpc' or ads.get('playbook', {}).get('bidding_strategy', '') == 'manual_cpc'
    evidence_says_manual = 'manual cpc' in cs_entry['evidence'].lower()
    checks.append({
        'name': 'bidding_strategy_match',
        'expected': 'manual_cpc' if expects_manual else ads.get('budget', {}).get('bidding_strategy', 'unknown'),
        'actual': 'manual_cpc' if evidence_says_manual else cs_entry['evidence'][:80],
        'pass': not expects_manual or evidence_says_manual
    })

# Cross-check: campaign status = paused
status_entry = entries.get('campaign_status', {})
if status_entry.get('evidence'):
    checks.append({
        'name': 'campaign_paused',
        'expected': 'paused',
        'actual': status_entry['evidence'][:80],
        'pass': 'paus' in status_entry['evidence'].lower()
    })

# Conditional check: sitelink assets (only when ads.yaml has non-empty sitelinks)
sitelinks = ads.get('sitelinks', [])
if sitelinks:  # non-empty list
    sl_entry = entries.get('sitelink_assets', {})
    has_sl_evidence = bool(sl_entry.get('evidence', '').strip())
    checks.append({
        'name': 'evidence_exists_sitelink_assets',
        'expected': 'non-empty evidence',
        'actual': sl_entry.get('evidence', '')[:120] if has_sl_evidence else 'MISSING',
        'pass': has_sl_evidence
    })

# --- Read-back cross-checks (only when readback completed) ---
readback = {}
readback_completed = False
rb_file = '.runs/distribute-campaign-readback-tmp.json'
if os.path.exists(rb_file):
    readback = json.load(open(rb_file))

if readback.get('status') == 'completed':
    rb_settings = readback.get('settings', {})
    readback_completed = True

    # Readback check 1: Bidding strategy
    rb_bid = rb_settings.get('bidding_strategy', {})
    expects_manual = ads.get('budget', {}).get('bidding_strategy', '') == 'manual_cpc' or ads.get('playbook', {}).get('bidding_strategy', '') == 'manual_cpc'
    actual_manual = 'manual cpc' in str(rb_bid.get('actual', '')).lower()
    checks.append({
        'name': 'readback_bidding_strategy',
        'expected': 'Manual CPC' if expects_manual else 'unknown',
        'actual': str(rb_bid.get('actual', 'NOT_READ')),
        'pass': not expects_manual or actual_manual
    })

    # Readback check 2: Enhanced CPC
    rb_ecpc = rb_settings.get('enhanced_cpc', {})
    checks.append({
        'name': 'readback_enhanced_cpc',
        'expected': 'OFF (unchecked)',
        'actual': 'OFF' if rb_ecpc.get('actual') == False else 'ON',
        'pass': rb_ecpc.get('actual') == False
    })

    # Readback check 3: Daily budget
    rb_budget = rb_settings.get('daily_budget', {})
    expected_budget = ads.get('budget', {}).get('daily_budget_cents', 0) / 100
    actual_str = str(rb_budget.get('actual', ''))
    try:
        actual_budget = float(actual_str.replace('$','').replace(',',''))
    except ValueError:
        actual_budget = -1
    checks.append({
        'name': 'readback_daily_budget',
        'expected': f'${expected_budget:.2f}',
        'actual': actual_str,
        'pass': abs(actual_budget - expected_budget) < 0.02
    })

    # Readback check 4: Networks
    rb_nets = rb_settings.get('networks', {})
    actual_nets = rb_nets.get('actual', {})
    sp = actual_nets.get('search_partners')
    dn = actual_nets.get('display_network')
    checks.append({
        'name': 'readback_networks',
        'expected': 'Search Partners OFF, Display Network OFF',
        'actual': 'SP=%s, DN=%s' % (sp, dn),
        'pass': sp == False and dn == False
    })

    # Readback check 5: Max CPC
    rb_cpc = rb_settings.get('max_cpc', {})
    expected_cpc = ads.get('guardrails', {}).get('max_cpc_cents', 0) / 100
    actual_cpc_str = str(rb_cpc.get('actual', ''))
    try:
        actual_cpc = float(actual_cpc_str.replace('$','').replace(',',''))
    except ValueError:
        actual_cpc = -1
    checks.append({
        'name': 'readback_max_cpc',
        'expected': f'${expected_cpc:.2f}',
        'actual': actual_cpc_str,
        'pass': abs(actual_cpc - expected_cpc) < 0.02
    })

    # Readback check 6: Match type
    rb_match = rb_settings.get('keywords_match_type', {})
    checks.append({
        'name': 'readback_match_type',
        'expected': 'Phrase match',
        'actual': str(rb_match.get('actual', 'NOT_READ')),
        'pass': 'phrase' in str(rb_match.get('actual', '')).lower()
    })

all_passed = all(c['pass'] for c in checks)
audit = {
    'checked_at': datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'all_passed': all_passed,
    'checks': checks,
    'evidence_file': '.runs/distribute-campaign-evidence.json',
    'ads_yaml': 'experiment/ads.yaml',
    'readback': readback if readback.get('status') else None,
    'readback_completed': readback_completed
}
json.dump(audit, open('.runs/distribute-campaign-audit.json', 'w'), indent=2)
status = 'PASSED' if all_passed else 'FAILED'
passed_count = sum(1 for c in checks if c['pass'])
print(f'AUDIT: {status} -- {passed_count}/{len(checks)} checks passed')
if not all_passed:
    for c in checks:
        if not c['pass']:
            name, exp, act = c['name'], c['expected'], c['actual']
            print(f'  FAILED: {name} -- expected: {exp}, actual: {act}')
"
```

If `all_passed` is False:

> **Campaign audit FAILED.** The following checks did not pass:
> {list each failed check with name, expected, actual}
>
> Please fix these in the Google Ads UI, then re-run `/distribute` -- step 6a will detect the existing campaign and skip to 6j for re-audit.

**STOP and wait for user.** Do not proceed to 6f until audit passes.

If `all_passed` is True:

> Campaign audit passed ({N}/{N} checks). Proceeding to pre-launch review.

### 6k: Pre-launch settings review

Read `phase` from `.runs/distribute-context.json`. **This step runs for all phases.**

After the automated audit passes (evidence checks + Chrome MCP read-back), present a visual settings summary for the user to verify against the live Google Ads dashboard. This is the final human defense-in-depth layer — it catches edge cases that automated read-back might miss (e.g., settings that render differently than expected in the accessibility tree).

Read the audit file. If `readback_completed` is `false` and `manual_creation` is not `true`, prepend a warning:

> **Warning:** Automated read-back verification could not complete. Your manual confirmation below is the only verification that campaign settings match ads.yaml. Please check each setting carefully.

Read critical settings from `experiment/ads.yaml` and display:

> **Pre-Launch Settings Review**
>
> Please open your campaign dashboard and verify these critical settings match what Google Ads actually saved:
>
> **Campaign URL:** {campaign_url from ads.yaml}
>
> | # | Setting | Expected Value | Where to Check |
> |---|---------|---------------|----------------|
> | 1 | Bidding strategy | **Manual CPC** | Settings > Bidding |
> | 2 | Enhanced CPC | **OFF** | Settings > Bidding > Enhanced CPC checkbox |
> | 3 | Max CPC | **${max_cpc_cents / 100}** | Ad group > Default max CPC |
> | 4 | Daily budget | **${daily_budget_cents / 100}/day** | Settings > Budget |
> | 5 | Networks | **Google Search only** | Settings > Networks (Search Partners OFF, Display OFF) |
> | 6 | Locations | **{target_geo}** | Settings > Locations |
> | 7 | Keywords | **{N} keywords, Phrase Match** | Keywords tab |
> | 8 | Campaign status | **Paused** | Campaign dashboard |
>
> Reply **confirmed** after checking, or tell me what needs to be fixed.

**STOP.** Do not proceed until the user replies **confirmed** (or equivalent affirmative).

If the user reports a mismatch:
1. Guide them to fix it in the Google Ads UI (provide the specific navigation path from the "Where to Check" column)
2. After they fix it, re-present the table for re-confirmation
3. Do not proceed until all settings are confirmed correct

Record the confirmation:
```bash
python3 -c "
import json, datetime
audit_file = '.runs/distribute-campaign-audit.json'
audit = json.load(open(audit_file))
audit['user_confirmed'] = True
audit['confirmed_at'] = datetime.datetime.now(datetime.UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump(audit, open(audit_file, 'w'), indent=2)
print('Pre-launch review confirmed by user')
"
```

### 6f: Phase 1 launch protocol

Read `phase` from `.runs/distribute-context.json`. If phase is 1:

1. Campaign was created in PAUSED status (standard).
2. Compute the recommended unpause date (48 hours from campaign creation):
   ```bash
   UNPAUSE_DATE=$(python3 -c "
   import datetime
   unpause = datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=48)
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
python3 -c "
import json, datetime
with open('.runs/q-dimensions.json', 'w') as f:
    json.dump({
        'skill': 'distribute',
        'scope': 'distribute',
        'dims': {'campaign': float($CAMPAIGN_CREATED), 'completion': 1.0},
        'run_id': '$RUN_ID',
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }, f, indent=2)
print('Wrote .runs/q-dimensions.json')
" || true
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
> **Day 0 ({recommended_unpause_date}):** Run `/iterate --check` — if all ads are approved, it will unpause the campaign automatically. If ads are still disapproved or in review, re-run `/iterate --check` the next day. Most ads are approved within 24-48 hours. If still disapproved after 48 hours, review and adjust ad copy in the ad platform dashboard, or contact platform support.
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
manual = ads.get('manual_creation', False)
has_evidence = os.path.exists('.runs/distribute-campaign-evidence.json')
if ads.get('campaign_id') and (has_evidence or manual):
    steps.extend(['6b','6c','6d','6e'])
elif ads.get('campaign_id'):
    # campaign_id exists but no evidence file and not manual -- evidence required
    steps.extend(['6b','6c','6d'])
audit_file = '.runs/distribute-campaign-audit.json'
if os.path.exists(audit_file):
    audit = json.load(open(audit_file))
    if audit.get('all_passed') or audit.get('manual_creation'):
        steps.append('6j')
    if audit.get('user_confirmed'):
        steps.append('6k')
if ads.get('launch_protocol') or ads.get('campaign_id'):
    steps.append('6f')
steps.append('6g')
pr = subprocess.run(['gh','pr','view','--json','number'], capture_output=True, text=True)
if pr.returncode == 0:
    steps.append('6h')
if os.path.exists('.runs/q-dimensions.json'):
    steps.append('q_score')
steps.append('6i')
os.makedirs('.runs', exist_ok=True)
json.dump({
    'steps_completed': steps,
    'key_outputs': {
        'campaign_id': str(ads.get('campaign_id', '')),
        'image_assets_uploaded': str(ads.get('image_assets_uploaded', 'false')),
        'sitelink_assets_created': str(bool(ads.get('sitelinks', []))),
        'phase': json.load(open('.runs/distribute-context.json')).get('phase', 0) if os.path.exists('.runs/distribute-context.json') else 0,
        'audit_passed': str(os.path.exists(audit_file) and (json.load(open(audit_file)).get('all_passed', False) or json.load(open(audit_file)).get('manual_creation', False))) if os.path.exists(audit_file) else 'false',
        'readback_completed': str(json.load(open(audit_file)).get('readback_completed', False)) if os.path.exists(audit_file) else 'false'
    }
}, open('.runs/distribute-step-check.json', 'w'), indent=2)
print('SELF-CHECK: wrote .runs/distribute-step-check.json with', len(steps), 'steps')
"
```

This checkpoint is mandatory. Do not skip it.

**POSTCONDITIONS:**
- Campaign created via Chrome MCP with campaign_id/campaign_url in ads.yaml, OR existing campaign detected and skipped
- Campaign audit passed (`.runs/distribute-campaign-audit.json` with `all_passed: true`) or manual_creation path confirmed
- Chrome MCP read-back completed (`.runs/distribute-campaign-audit.json` with `readback_completed: true`) or manual_creation path
- User confirmed pre-launch settings review (`.runs/distribute-campaign-audit.json` with `user_confirmed: true`)
- PR auto-merged to main (or intentionally skipped with reason)
- `.runs/distribute-step-check.json` exists with steps 6a, 6e, 6j, 6k, 6f completed

**VERIFY:**
```bash
grep -q 'campaign_id' experiment/ads.yaml 2>/dev/null && python3 -c "import json; s=set(json.load(open('.runs/distribute-step-check.json')).get('steps_completed',[])); required={'6a','6e','6j','6k','6f'}; assert required.issubset(s), f'missing steps: {required - s}'" && python3 -c "import json; d=json.load(open('.runs/distribute-campaign-audit.json')); assert d.get('all_passed')==True or d.get('manual_creation')==True, 'campaign audit not passed'; assert d.get('user_confirmed')==True, 'user has not confirmed pre-launch settings review'" && python3 -c "import json; d=json.load(open('.runs/distribute-campaign-audit.json')); m=d.get('manual_creation',False); assert d.get('readback_completed')==True or m==True, 'readback not completed and not manual creation'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 6
```

**NEXT:** TERMINAL — campaign is ready, PR auto-merged (or left open with reason). Follow the next steps in 6i.
