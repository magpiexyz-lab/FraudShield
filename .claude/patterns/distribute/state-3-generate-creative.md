# STATE 3: GENERATE_CREATIVE

**PRECONDITIONS:**
- Targeting research generated (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

Derive from experiment.yaml `name`, `description`, and `thesis`.

### Ad format constraints

Read the selected channel's stack file "Ad Format Constraints" section for character limits, creative format, and minimum variations. Apply these constraints when generating ad copy.

### Copy principles
- Headline = outcome for target_user (what they get)
- Description/body = proof + CTA (why believe + what to do next)
- Include the landing URL with UTM parameters — read the channel's stack file "UTM Parameters" section for `utm_source` and `utm_medium` values: `?utm_source={channel_source}&utm_medium={channel_medium}&utm_campaign={campaign_name}`

### Hypothesis alignment (when spec-manifest.json exists)

If hypothesis context was loaded in Step 1.5:

- **Headlines**: derive from `demand` hypothesis `statement`. If the hypothesis says "freelancers want AI-generated invoices from time logs", the headline should address that angle directly (e.g., "Turn Time Logs Into Invoices in Seconds").
- **CTA**: align with the hypothesis `metric.formula`'s desired user action. If the formula is "signup_complete / visit_landing", the CTA should drive signups ("Start Free" > "Learn More"). If the formula is "cta_click / visit_landing", the CTA should be prominent and action-oriented.
- **Targeting angle**: if a `reach` hypothesis specifies a channel or audience (e.g., "freelancers on Reddit respond to invoicing pain"), use it to inform the targeting research in Step 2.

This is additive guidance — it refines the copy principles above, not replaces them. Message match rules from messaging.md still apply.

### Message match
Follow the message match rules in `.claude/patterns/messaging.md`. Ad headlines must be shortened versions of the landing page headline (the value proposition, not the product name). If the app has already been bootstrapped, read the surface source to extract the actual landing headline and derive ad headlines from it: for web-app read `src/app/page.tsx`; for service read the root route handler (path per framework stack file); for CLI read `site/index.html`. Note that character constraints are channel-specific — read the stack file's "Ad Format Constraints" for the channel's limits.

### Variant ad groups (when experiment.yaml has `variants`)
When experiment.yaml has a `variants` field, generate per-variant creative:
- Create a separate ad group/creative set per variant
- Each variant's creative is derived from that variant's `headline` field (not from the shared `description`)
- Each variant's landing URL includes `utm_content={slug}` (e.g., `?utm_source={source}&utm_medium={medium}&utm_campaign={campaign_name}&utm_content=speed`)
- Each variant's landing URL points to `/v/{slug}` (e.g., `https://example.vercel.app/v/speed?...`)
- Follow messaging.md Section D: ad headlines for a variant match that variant's landing page headline
- See `experiment/ads.example.yaml` for schema format examples

**POSTCONDITIONS:**
- Ad creative generated with headlines, descriptions/body, and CTAs
- Channel-specific format constraints applied (character limits, variation counts)
- Landing URLs include correct UTM parameters
- Message match verified against landing page headline
- If variants exist: per-variant ad groups generated with utm_content and /v/{slug} URLs

- **Write creative artifact** (`.claude/runs/distribute-creative.json`):
  ```bash
  python3 -c "
  import json
  creative = {
      'headlines': [],
      'descriptions': [],
      'utm_params_verified': True,
      'message_match_verified': True
  }
  json.dump(creative, open('.claude/runs/distribute-creative.json', 'w'), indent=2)
  "
  ```

**VERIFY:**
```bash
test -f .claude/runs/distribute-creative.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 3
```

**NEXT:** Read [state-4-generate-thresholds.md](state-4-generate-thresholds.md) to continue.
