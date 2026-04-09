---
assumes: []
packages:
  runtime: []
  dev: []
files: []
env:
  server: []
  client: []
ci_placeholders: {}
clean:
  files: []
  dirs: []
gitignore: []
---
# Distribution: Google Ads
> Used when `/distribute` is run with channel `google-ads`
> Assumes: None — distribution stacks create no source code or packages; they generate config only

## Ad Format Constraints

**Responsive Search Ads (RSA):**
- Headlines: 3–30 characters each, minimum 5 per ad
- Descriptions: up to 90 characters each, minimum 2 per ad
- Minimum 2 ad variations per campaign
- Google assembles the best combination from your headlines and descriptions

**Sitelink Extensions:**
- Link text: up to 25 characters (the clickable blue text)
- Description line 1: up to 35 characters
- Description line 2: up to 35 characters
- Final URL: must be distinct from the main ad landing URL and from all other sitelink URLs
- Minimum 2 sitelinks per campaign (Google rarely shows just 1)
- Maximum 4 sitelinks for Phase 1 (balances coverage vs complexity at $140 budget)
- Each sitelink must point to a different destination page or anchor section
- Auto-generated from `golden_path` pages — see state-4-generate.md Step 4b.5

## Targeting Model

**Keyword-based targeting** — ads appear when users search for matching terms.

Match types:
- **Exact match** `[keyword]` — highest intent, most specific
- **Phrase match** `"keyword"` — moderate intent, word order matters
- **Broad match** `keyword` — widest reach, Google infers intent
- **Negative keywords** — exclude irrelevant searches

Minimum keyword counts:
- Exact: 3+
- Phrase: 2+
- Broad: 1+
- Negative: 2+

No demographic or audience targeting initially — let Google optimize.

## Click ID

**Parameter name:** `gclid` (Google Click ID)

Google auto-appends `gclid` to the landing URL when a user clicks an ad. Capture it on the landing page and include it in analytics events for offline conversion matching.

## Conversion Tracking

1. Set up offline conversion import in Google Ads
2. Configure the analytics provider's Google Ads destination (see analytics stack file)
3. Map the `activate` event → Google Ads conversion action
4. Verify with a test conversion

Import method: analytics provider webhook → Google Ads Offline Conversions.

## Policy Restrictions

**Restricted industries:**
- **DeFi protocols, ICOs, token sales** — **BANNED**. Google Ads prohibits advertising decentralized finance protocols, initial coin offerings, and token sale events.
- **Crypto exchanges/wallets** — **RESTRICTED**. Requires FinCEN MSB registration + state money transmitter licenses (US) or MiCA CASP authorization (EU). Must apply for Google Ads Financial Products certification.
- **Gambling, pharma, weapons** — various restrictions apply; check Google Ads policies.

**Compliance notes:**
- Landing page must include clear disclaimers if promoting financial products
- Ads cannot make misleading claims about returns or guarantees
- Review [Google Ads Financial Products and Services policy](https://support.google.com/adspolicy/answer/2464998) before launching

## Cost Model

**CPC (Cost Per Click)** — you pay when a user clicks your ad.

Bidding phases:
- **Phase 1** (days 1-5): `manual_cpc` — set max CPC to Keyword Planner "Top of page bid (low range)" for each keyword. Full control over spend while learning which keywords convert.
- **Phase 2** (days 8-21): `manual_cpc` continues — adjust bids based on Phase 1 data. Exception: if projected conversions > 30 in the Phase 2 window, switch to `maximize_conversions` to let Google optimize.
- **Phase 3** (day 22+): `target_cpa` — set target CPA based on Phase 1-2 cost-per-conversion data. Only enter Phase 3 with 30+ total conversions.

- `guardrails.max_cpc_cents` sets a ceiling on individual bid amounts (Phase 1-2). Set initial value from Keyword Planner "Top of page bid (low range)".

Budget structure:
- `daily_budget_cents`: daily spend cap (= `total_budget_cents / duration_days`)
- `total_budget_cents`: total campaign cap (max 50000 / $500 without explicit override)
- `duration_days`: campaign length (set based on experiment duration)

## Config Schema

The `ads.yaml` file for Google Ads uses:

```yaml
channel: google-ads
campaign_name: {name}-search-v{N}
project_name: {name}
landing_url: {deployed_url}

keywords:
  exact: [...]
  phrase: [...]
  broad: [...]
  negative: [...]

ads:
  - headlines: [...]    # 5+ headlines, 3-30 chars each
    descriptions: [...]  # 2+ descriptions, up to 90 chars each

# When experiment.yaml has variants, use ad_groups instead of ads:
# ad_groups:
#   - variant: {slug}
#     landing_url: "{url}/v/{slug}?utm_source=google&utm_medium=cpc&utm_campaign={campaign}&utm_content={slug}"
#     ads:
#       - headlines: [...]
#         descriptions: [...]

sitelinks:
  - link_text: "..."            # up to 25 chars, imperative verb + noun
    description_1: "..."        # up to 35 chars, benefit statement
    description_2: "..."        # up to 35 chars, qualifier/differentiator
    final_url: "..."            # distinct URL with UTM params
# When <2 qualifying pages exist: sitelinks: []
# See state-4-generate.md Step 4b.5 for generation rules

budget:
  daily_budget_cents: ...
  total_budget_cents: ...
  duration_days: ...
  bidding_strategy: manual_cpc

targeting:
  locations: [US]
  languages: [en]

conversions:
  primary_action: activate
  secondary_actions: [signup_complete]
  import_method: posthog_webhook

guardrails:
  max_cpc_cents: ...
  min_daily_clicks: 3
  auto_pause_rules: [...]

thresholds:
  expected_clicks: ...
  expected_signups: ...
  expected_activations: ...
  go_signal: "..."
  no_go_signal: "..."
```

## Phase 1 Playbook

Step-by-step guide for the first 7 days of a Google Ads Search campaign. Follow this before adjusting any settings.

### Campaign Structure

| Setting | Value |
|---------|-------|
| Campaign type | Search |
| Network | Google Search only (disable Search Partners and Display Network) |
| Bidding | `manual_cpc` (Enhanced CPC OFF) |
| Max CPC | Keyword Planner "Top of page bid (low range)" per keyword |
| Daily budget | `total_budget_cents / duration_days` |
| Duration | Phase 1: 7 days, Phase 2: 14 days |
| Status | PAUSED (enable after pre-flight checklist passes) |

### Ad Group Structure

- **1 STAG** (Single Theme Ad Group) per campaign
- **5-15 keywords** per ad group, all on the same theme
- **Match type**: Phrase Match for all keywords. If a keyword gets zero impressions after 48 hours, switch that keyword to Broad Match.
- **2 RSAs** (Responsive Search Ads) per ad group

### RSA Template

```
Headlines (8 slots):
  H1: [MVP Name] — PINNED to position 1
  H2: [Primary value proposition] — PINNED to position 2
  H3-H8: Unpinned — rotate variations of benefits, features, social proof, urgency

Descriptions (4 slots):
  D1: [What the product does + primary benefit] (up to 90 chars)
  D2: [How it works or what makes it different] (up to 90 chars)
  D3: [Social proof or credibility signal] (up to 90 chars)
  D4: [Call to action with urgency] (up to 90 chars)
```

Pin H1 and H2 to ensure the MVP name and value prop always appear. Leave H3-H8 unpinned so Google can test combinations.

### Negative Keywords (Universal)

Add these 50 universal negative keywords to every campaign. They exclude traffic that wastes budget on informational, career, enterprise, or unrelated searches.

```
free
how to
what is
tutorial
guide
example
template
sample
course
training
certification
degree
salary
job
jobs
career
careers
hiring
intern
internship
enterprise
corporate
fortune 500
government
federal
download
open source
github
stackoverflow
reddit
review
reviews
comparison
vs
versus
alternative
alternatives
cheap
cheapest
discount
coupon
promo
scam
complaint
lawsuit
wiki
wikipedia
definition
meaning
pdf
```

These are starting negatives. Add campaign-specific negatives based on the experiment domain (e.g., competitor names that draw irrelevant clicks).

### Conversion Setup

- **Method**: Offline conversion import via `gclid`
- **Flow**: Landing page captures `gclid` from URL → stored with user record → on `activate` event, analytics provider sends conversion with `gclid` to Google Ads Offline Conversions API
- **Verification**: Complete one test conversion end-to-end before enabling the campaign

### Sitelink Strategy

- **Auto-generate** sitelinks from experiment.yaml `golden_path` when the app has 2+ non-landing user-facing pages
- **Priority order**: real independent pages (signup, dashboard, etc.) > anchor sections on the landing page (`/#features`, `/#pricing`) > skip
- **Anchor fallback**: When independent pages < 2, scan the landing page component for section elements with `id` attributes (e.g., `id="features"`, `id="pricing"`) and generate anchor sitelinks
- **Combined threshold**: independent pages + anchor sections must total >= 2, otherwise skip sitelinks entirely
- **Phase 1 cap**: maximum 4 sitelinks
- **Copy rules**: follow messaging.md Section F for link_text, description_1, description_2 derivation
- **UTM tracking**: each sitelink URL includes `utm_content=sitelink_{route_slug}` (or `sitelink_anchor_{section_id}` for anchors)

### Pre-flight Checklist

Before enabling the campaign:

1. [ ] Campaign status is PAUSED
2. [ ] Landing page PageSpeed score >= 70 (mobile)
3. [ ] All ads approved by Google (check ad status — allow 48 hours for review)
4. [ ] Conversion tracking verified with a test conversion
5. [ ] Negative keywords added (50 universal + campaign-specific)
6. [ ] UTM parameters set correctly on all final URLs
7. [ ] Daily budget matches `total_budget_cents / duration_days`
8. [ ] `gclid` capture verified on landing page (click ad preview, check analytics for `gclid` property)

### Phase 1 Monitoring (Days 1-5)

| Metric | Check frequency | Action threshold |
|--------|----------------|-----------------|
| Impressions | Daily | < 50/day after day 2 → switch low-impression keywords to Broad Match |
| CTR | Daily | < 1% after 500 impressions → revise ad copy |
| Avg CPC | Daily | > 2x initial max CPC → lower bids or pause expensive keywords |
| Conversions | Day 4+ | 0 conversions after 50% budget spent → verify tracking, check landing page |
| Search terms report | Day 3, Day 7 | Add irrelevant terms to negative keywords |

## UTM Parameters

- `utm_source=google`
- `utm_medium=cpc`
- `utm_campaign={campaign_name}`
- `utm_content={variant_slug}` (when using variants)
- `utm_content=sitelink_{route_slug}` (for sitelink traffic to independent pages)
- `utm_content=sitelink_anchor_{section_id}` (for sitelink traffic to anchor sections)

## Setup Instructions

### One-Time MCC Setup
1. **Create Google Ads MCC** (Manager Account) — see `.claude/procedures/google-ads-setup.md` for details

### Per-Member Setup (one-time per team member)
1. **Create a subaccount** — in the MCC, click "+ New Google Ads account" → name it `{member-name}-ads`. Billing is inherited from the MCC — do not add a separate payment method
2. **Complete Advertiser Verification** — Google will prompt verification for the new account. Complete it once — all future MVPs under this account skip verification
3. **Save Customer ID** — note the account's Customer ID (digits only, no dashes) and save it to `~/.google-ads/customer-id`

### Per-Campaign Setup (do this for each MVP)
1. **Switch to the member's subaccount** — click the subaccount name in the MCC account list to enter it
2. **Create conversion actions** — see `.claude/procedures/google-ads-setup.md` Step 6 for detailed steps
3. **Configure analytics destination** — see analytics stack file for provider-specific instructions
4. **Map events** — `activate` event → the conversion action from step 2

### Dashboard Filter

Filter analytics dashboard by `utm_source = "google"` to see paid traffic performance.

## Chrome MCP Campaign Creation

Campaign creation uses Chrome MCP to interact with the Google Ads web UI directly. No API credentials needed — the user just needs to be logged into Google Ads in Chrome.

### Prerequisites

1. **Claude in Chrome extension** installed and connected (see `.claude/patterns/chrome-mcp-setup-guide.md`)
2. **Google Ads account** — user is logged into their sub-account in Chrome
3. **Chrome tab** with Google Ads open

If any prerequisite is missing, `/distribute` state-6 will detect it and show the setup guide automatically.

### Conversion Action Setup

Before creating a campaign, `/distribute` state-6 Step 0 ensures a conversion action exists in the sub-account for offline conversion import (gclid → Google Ads).

| Setting | Value |
|---------|-------|
| Name | `MVP Signup` |
| Category | Lead → Sign-up |
| Source | Import (Other data sources or CRMs → Track conversions from clicks) |
| Count | One (one conversion per click) |
| Value | Don't use a value |
| Window | 30 days |

**Per sub-account, not per campaign.** Each team member has one sub-account. All their MVP campaigns share this `MVP Signup` action. Google Ads attributes conversions to the correct campaign automatically via the gclid.

**Idempotent.** Step 0 checks the conversions list first. If `MVP Signup` already exists, it skips creation.

**gclid import flow.** After campaigns run, `/iterate --check` queries PostHog for conversions with gclid, generates a CSV, and uploads it via Chrome MCP (Tools → Conversions → Uploads). This is incremental — each check cycle imports only new conversions since the last import.

### Campaign Creation Flow (via Chrome MCP)

`/distribute` state-6 performs these steps in the Google Ads UI:

1. Click "+ New campaign" → "Create a campaign without a goal's guidance" → Search
2. Set campaign name, uncheck Search Partners and Display Network
3. Set locations from `target_geo`, budget from ads.yaml, Manual CPC bidding
4. Create ad group with keywords (Phrase Match)
5. Create 2 RSAs from ads.yaml creative config
6. Add negative keywords at campaign level
7. Save campaign in PAUSED status
8. Record `campaign_id` and `campaign_url` in ads.yaml
9. Capture product screenshots and upload as Image Assets (user approves before upload)
10. Create sitelink extensions from ads.yaml `sitelinks` array (if non-empty)

### Image Assets

Google Search ads support optional Image Assets displayed alongside the text ad. `/distribute` state-6 Step 7.5 automates this by screenshotting the deployed MVP landing page.

| Spec | Dimensions | Content |
|------|-----------|---------|
| Landscape | 1200×628 | Hero section (headline + visual) |
| Square | 1200×1200 | Product UI / feature showcase |

**Process:** Chrome MCP opens the deployed URL → waits for full load → dismisses overlays → takes screenshots → crops to spec via imagemagick → shows to user for approval → uploads to Google Ads campaign Assets.

**Quality requirements:** Page must be fully loaded (no skeletons/spinners). No cookie banners, chat widgets, or popups visible. Use light mode if the page supports dark/light toggle.

**User approval gate:** Screenshots are shown to the user before upload. User can approve, request a different page section, or skip entirely.

### Error Handling

If Chrome MCP fails at any step, the skill:
1. Screenshots the error state
2. Reports which step failed
3. Retries up to 2 times, then asks user to resolve the issue and re-run `/distribute`
