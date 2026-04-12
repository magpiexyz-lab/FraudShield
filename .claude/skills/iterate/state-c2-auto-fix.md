# STATE c2: AUTO_FIX

**PRECONDITIONS:**
- Health check complete (STATE c1 POSTCONDITIONS met)
- `.runs/iterate-check-health.json` exists

**ACTIONS:**

### Check for issues

Read `.runs/iterate-check-health.json`. If `issues` array is empty:
> "Campaign healthy -- no issues detected. Skipping auto-fix."

Write an empty fixes file and proceed to STATE c3:
```bash
python3 -c "
import json
fixes = {'campaign_name': '<name>', 'fixed_at': '<ISO 8601>', 'issues_found': 0, 'fixes_applied': 0, 'fixes_recommended': 0, 'details': []}
json.dump(fixes, open('.runs/iterate-check-fixes.json', 'w'), indent=2)
"
```

### Process issues by type

Read `campaign_age_days` from `.runs/iterate-check-context.json`. For each issue, apply the fix:

---

#### Issue: `zero_impressions`

**If campaign age < 48 hours:**
- Navigate to campaign **Keywords** tab via Chrome MCP
- Check each keyword's **Max CPC** vs the **Top of page bid (high range)** estimate shown by Google
- If Max CPC is below the suggested high range, increase it to match the high range
- Via Chrome MCP: click the keyword's bid, update the value, save
- Record: "Raised max CPC on {N} keywords to match suggested high range"

**If campaign age >= 48 hours and < 72 hours:**
- Switch all Phrase Match keywords to Broad Match:
  - Navigate to Keywords tab, edit match type for each keyword
- Add 20 additional negative keywords relevant to the experiment's domain:
  - Read `experiment/experiment.yaml` for context (what the product does, who it's for)
  - Generate 20 domain-specific negative keywords that filter out irrelevant intent (informational queries, competitor names, unrelated verticals)
  - Add them at the campaign level via Chrome MCP: Keywords > Negative keywords > Add
- Record: "Switched {N} keywords to Broad Match, added 20 negative keywords"

**If campaign age >= 72 hours:**
- Mark the campaign as **NO-GO**: the experiment hypothesis is not attracting search interest
- Pause the campaign via Chrome MCP: Campaign Settings > Status > Paused
- Notify the user:
  > "Campaign has 0 impressions after 72+ hours. This is a NO-GO signal -- the target keywords have no search volume or bids are not competitive. Campaign has been paused. Consider: (1) Run `/iterate` for a full funnel analysis and KILL/PIVOT decision. (2) Run `/retro` to document learnings."
- Record: "NO-GO: paused campaign after 72h with 0 impressions"

---

#### Issue: `disapproved`

1. Navigate to the campaign's **Ads** tab via Chrome MCP
2. Click on the disapproved ad to view the policy violation details
3. Read the disapproval reason (e.g., "Misleading claim", "Trademark violation", "Destination mismatch")
4. AI-rewrite the ad copy to comply with the policy:
   - Keep the same RSA structure (5+ headlines, 2+ descriptions)
   - Address the specific policy violation
   - Maintain the experiment's value proposition from ads.yaml
   - Follow headline length limits (3-30 chars) and description limits (up to 90 chars)
5. Create a new ad with the rewritten copy via Chrome MCP:
   - Navigate to Ads > click "+" to create new ad
   - Fill in the rewritten headlines and descriptions
   - Save the new ad
6. Notify the user:
   > "Ad was disapproved for [{reason}]. Created a replacement ad with compliant copy. Please check ad approval status in 24-48h. Original ad left in place for reference -- you can remove it manually after the new one is approved."
7. Record: "Ad disapproved for {reason}. Created replacement ad. Review in 24-48h."

---

#### Issue: `sitelink_disapproved`

1. Navigate to the campaign's **Ads & assets** → **Assets** tab via Chrome MCP
2. Click on the disapproved sitelink to view the disapproval reason
3. Read the disapproval reason (e.g., "Destination not working", "Misleading content", "Policy violation")
4. AI-rewrite the sitelink to comply:
   - If destination URL is broken: check if the page exists at the `final_url`. If not, replace with an anchor sitelink on the landing page (fallback to a working destination)
   - If copy violates policy: rewrite `link_text`/descriptions following messaging.md Section F rules while addressing the specific violation
   - Preserve UTM parameters in the new `final_url`
   - Respect character limits: link_text ≤ 25, descriptions ≤ 35
5. Create a replacement sitelink via Chrome MCP:
   - Click "+" → "Sitelink" in the Assets tab
   - Enter the rewritten link_text, description_1, description_2, final_url
   - Save
6. Leave the original disapproved sitelink in place for reference (user can remove manually)
7. Notify the user:
   > "Sitelink '{link_text}' was disapproved for [{reason}]. Created a replacement sitelink with compliant copy. Review approval status in 24-48h."
8. Record: "Sitelink disapproved for {reason}. Created replacement. Original left for reference."

---

#### Issue: `wasted_clicks`

1. Read the problematic search terms from the health check (terms with cost > $1 AND CTR < 1%)
2. Present the list to the user:
   > "Found {N} irrelevant search terms consuming budget:"
   > | Search Term | Cost | Clicks | CTR |
   > |------------|------|--------|-----|
   > | {term} | ${cost} | {clicks} | {ctr}% |
3. Add all identified terms as **negative keywords** at the campaign level:
   - Via Chrome MCP: Keywords > Negative keywords > click "+" > add all terms
   - Use Exact Match for the negative keywords (bracket syntax)
4. Record: "Added {N} negative keywords: [{term1}], [{term2}], ..."

---

#### Issue: `campaign_paused`

Read `phase` from `.runs/iterate-check-context.json`. If `phase` is `1`, follow the Phase 1 protocol below. If `phase` is `2`, `null`, or absent, follow the "NOT Phase 1" branch.

**If Phase 1 protocol (phase == 1):**

Check ad approval status first:
1. Navigate to campaign **Ads** tab via Chrome MCP
2. Check if ALL ads have status "Approved" (not "Under review", "Disapproved", etc.)

**If all ads approved AND campaign age >= 48 hours:**
- Unpause the campaign via Chrome MCP: Campaign Settings > Status > Enabled
- Notify the user:
  > "All ads approved. Campaign unpaused and now active. Monitor with `/iterate --check` on Days 1 and 3."
- Record: "Campaign unpaused -- all ads approved after {age} hours"

**If some ads still disapproved or in review:**
- Do NOT unpause
- Notify the user:
  > "Campaign still paused -- {N} ad(s) are still {status}. Re-run `/iterate --check` tomorrow. Most ads are approved within 24-48 hours. If still disapproved after 48 hours, review and adjust ad copy in Google Ads, or contact platform support."
- Record: "Campaign remains paused -- {N} ads not yet approved"

**If campaign age < 48 hours:**
- This is expected during Phase 1 Day -2/Day -1 protocol
- Record: "Campaign paused (Phase 1 protocol, age {age}h < 48h) -- no action needed"

**If NOT Phase 1 (user-initiated pause or unknown):**
- Do NOT auto-unpause — the user may have paused intentionally
- Record: "Campaign paused (not Phase 1 protocol) -- skipping auto-fix. Resume manually in Google Ads if intended."

---

#### Issue: `budget_anomaly`

**If campaign age <= 2 days AND spend > 50% of total budget:**
- This is a critical overspend -- the campaign will exhaust budget before the experiment window ends
- Pause the campaign via Chrome MCP: Campaign Settings > Status > Paused
- Notify the user:
  > "Budget anomaly: {spend_pct}% of total budget consumed in {age} days. Campaign paused to prevent premature budget exhaustion. Recommended: (1) Check if max CPC is too high relative to keyword competition. (2) Review search terms for broad/irrelevant traffic driving up costs. (3) Resume campaign with adjusted bids after review."
- Record: "Paused campaign -- {spend_pct}% budget consumed in {age} days"

**If underspend (actual spend < 30% of expected):**
- This is informational -- underspend usually means low impression volume
- If `zero_impressions` is also flagged, that issue handler covers the fix
- If impressions exist but spend is low, it may indicate low bid competitiveness
- Record: "Underspend detected -- {spend_pct}% of expected. Check bid competitiveness."

---

#### Post-fix: gclid offline conversion import

After processing all health issues, import offline conversions from PostHog to Google Ads. This runs on every `--check` cycle and is incremental.

**Skip conditions** (check all before proceeding):
- Channel in ads.yaml is not `google-ads` → skip
- `~/.posthog/personal-api-key` does not exist → skip, log "Skipping gclid import — PostHog API key not configured"
- Chrome MCP tools unavailable → skip, log "Skipping gclid import — Chrome MCP not available"

**Step 1: Determine import window**

Read `last_gclid_import_at` from `.runs/iterate-check-context.json`. If absent (first run), use campaign start date from ads.yaml. If neither exists, use 30 days ago.

**Step 2: Query PostHog for conversions with gclid**

Read PostHog credentials and project ID per the Auto Query procedure in `.claude/stacks/analytics/posthog.md`.

HogQL query — join reach events (have gclid) with demand events (conversion) by distinct_id:
```sql
SELECT
  reach.properties.gclid AS gclid,
  min(demand.timestamp) AS conversion_time
FROM events AS demand
INNER JOIN events AS reach
  ON demand.distinct_id = reach.distinct_id
  AND reach.properties.funnel_stage = 'reach'
  AND reach.properties.gclid IS NOT NULL
  AND reach.properties.gclid != ''
WHERE demand.properties.project_name = {project_name}
  AND demand.properties.funnel_stage = 'demand'
  AND demand.timestamp > {last_import_at}
GROUP BY gclid
```

Note: gclid is captured on the reach event (landing page), not on the demand event (signup). The join by distinct_id links "which user clicked the ad" to "which user converted."

If query returns 0 rows → log "No new conversions with gclid since last import" → skip to Write fixes artifact.

**Step 3: Generate CSV**

Format results as Google Ads offline conversion CSV:
```csv
Google Click ID,Conversion Name,Conversion Time
{gclid},MVP Signup,{conversion_time in yyyy-MM-dd HH:mm:ss format}
```

Rules:
- Conversion Name must match: `MVP Signup` (created in /distribute state-6 Step 0)
- Conversion Time: `yyyy-MM-dd HH:mm:ss` format (UTC)
- Deduplicate by gclid (one conversion per click)
- Write to `/tmp/gclid-import-{timestamp}.csv`

**Step 4: Upload via Chrome MCP**

1. Navigate to **Tools & Settings** → **Measurement** → **Conversions**
2. Click **Uploads** tab
3. Click **"+" (Upload)**
4. Select **"Upload a file"** → choose the CSV from Step 3
5. Click **"Upload and apply"**
6. Wait for processing (status: "Processing" → "Done" or "Partially applied")
7. Read result:
   - "Done": record number of conversions imported
   - "Partially applied": read error details, log them (expired gclids are expected, not errors)

If Chrome MCP cannot handle file upload dialog, fallback: copy CSV content → use "paste" upload option in the Google Ads UI.

After upload (success or failure), clean up the CSV file:
```bash
rm -f /tmp/gclid-import-*.csv
```

**Step 5: Update import timestamp**

```bash
python3 -c "
import json
from datetime import datetime
ctx = json.load(open('.runs/iterate-check-context.json'))
ctx['last_gclid_import_at'] = datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
json.dump(ctx, open('.runs/iterate-check-context.json', 'w'), indent=2)
"
```

**Step 6: Record in fixes**

Add gclid_import entry:
```json
{
  "issue_type": "gclid_import",
  "action_taken": "applied",
  "description": "Uploaded {N} offline conversions to Google Ads. {M} accepted, {K} rejected."
}
```

---

### Write fixes artifact

```bash
python3 -c "
import json
fixes = {
    'campaign_name': '<name>',
    'fixed_at': '<ISO 8601>',
    'issues_found': <N>,
    'fixes_applied': <N>,
    'fixes_recommended': <N>,
    'details': [
        {
            'issue_type': '<type>',
            'diagnosis': '<what was found>',
            'action_taken': '<applied|recommended|skipped>',
            'description': '<what was done or recommended>'
        }
    ]
}
json.dump(fixes, open('.runs/iterate-check-fixes.json', 'w'), indent=2)
"
```

Replace all placeholder values with actual data from the fix actions performed.

**POSTCONDITIONS:**
- Each issue from health report processed (fixed or recommendation provided)
- `.runs/iterate-check-fixes.json` exists
- User informed of all findings and actions taken

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-check-fixes.json')); assert d.get('campaign_name'), 'campaign_name empty'; assert d.get('fixed_at'), 'fixed_at empty'; assert isinstance(d.get('issues_found'), int), 'issues_found not int'; assert isinstance(d.get('fixes_applied'), int), 'fixes_applied not int'; assert isinstance(d.get('details'), list), 'details not a list'; assert d['fixes_applied'] <= d['issues_found'], 'fixes_applied > issues_found'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-check c2
```

**NEXT:** Read [state-c3-report.md](state-c3-report.md) to continue.
