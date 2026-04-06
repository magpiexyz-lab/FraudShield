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
test -f .runs/iterate-check-fixes.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-check c2
```

**NEXT:** Read [state-c3-report.md](state-c3-report.md) to continue.
