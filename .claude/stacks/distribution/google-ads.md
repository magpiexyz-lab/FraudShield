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
- **Phase 1** (days 1-7): `manual_cpc` — set max CPC to Keyword Planner "Top of page bid (low range)" for each keyword. Full control over spend while learning which keywords convert.
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

### Phase 1 Monitoring (Days 1-7)

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

## Setup Instructions

### One-Time MCC Setup
1. **Create Google Ads MCC** (Manager Account) — see `docs/google-ads-setup.md` for details

### Per-Member Setup (one-time per team member)
1. **Create a subaccount** — in the MCC, click "+ New Google Ads account" → name it `{member-name}-ads`. Billing is inherited from the MCC — do not add a separate payment method
2. **Complete Advertiser Verification** — Google will prompt verification for the new account. Complete it once — all future MVPs under this account skip verification
3. **Save Customer ID** — note the account's Customer ID (digits only, no dashes) and save it to `~/.google-ads/customer-id`

### Per-Campaign Setup (do this for each MVP)
1. **Switch to the member's subaccount** — click the subaccount name in the MCC account list to enter it
2. **Create conversion actions** — see `docs/google-ads-setup.md` Step 6 for detailed steps
3. **Configure analytics destination** — see analytics stack file for provider-specific instructions
4. **Map events** — `activate` event → the conversion action from step 2

### Manual Campaign Creation (when no API credentials)
1. **Create a campaign** — in the member's subaccount, click "+ New campaign" → use targeting, keywords, ad copy, and budget from `experiment/ads.yaml`
2. **Set UTM parameters** — apply the final URLs and tracking templates from `experiment/ads.yaml`
3. **Verify** — click your own ad, complete the activation flow, confirm the event appears in analytics

### Dashboard Filter

Filter analytics dashboard by `utm_source = "google"` to see paid traffic performance.

## API Campaign Creation

Automated campaign creation via the Google Ads API. Used by `/distribute` Step 9 when credentials are available.

### Credential Files

| File | Contents |
|------|----------|
| `~/.google-ads/developer-token` | 22-character API developer token |
| `~/.google-ads/client-id` | OAuth2 client ID |
| `~/.google-ads/client-secret` | OAuth2 client secret |
| `~/.google-ads/refresh-token` | OAuth2 refresh token |
| `~/.google-ads/mcc-id` | Manager account ID (digits only, no dashes) |
| `~/.google-ads/customer-id` | Member's subaccount Customer ID (digits only, no dashes) |

### Credential Check

Check all 6 files exist with `test -f`. If any are missing, show which are missing and guide the user through the Setup steps below. Do not fall back to manual — credentials are required.

### Setup

1. **Create an MCC (Manager Account)** at [ads.google.com/home/tools/manager-accounts/](https://ads.google.com/home/tools/manager-accounts/) if you don't have one. Save the MCC ID (digits only) to `~/.google-ads/mcc-id`.
2. **Apply for a developer token** — in the MCC, go to Tools & Settings → API Center → Apply for a developer token. The token starts in "Test Account" access level (sufficient for creating real campaigns under your own MCC). Save the 22-character token to `~/.google-ads/developer-token`.
3. **Create OAuth2 credentials** — go to [Google Cloud Console](https://console.cloud.google.com/), create a project (or use an existing one), enable the "Google Ads API", then go to Credentials → Create Credentials → OAuth 2.0 Client ID → Desktop App. Save the client ID to `~/.google-ads/client-id` and client secret to `~/.google-ads/client-secret`.
4. **Generate a refresh token** — use the OAuth2 flow to get a refresh token with scope `https://www.googleapis.com/auth/adwords`:
   ```bash
   # Open this URL in a browser and authorize:
   echo "https://accounts.google.com/o/oauth2/v2/auth?client_id=$(cat ~/.google-ads/client-id)&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/adwords&access_type=offline&prompt=consent"
   # After authorization, Google redirects to localhost with a ?code= parameter.
   # Exchange the code for tokens:
   curl -s -X POST https://oauth2.googleapis.com/token \
     -d "code=AUTH_CODE_HERE" \
     -d "client_id=$(cat ~/.google-ads/client-id)" \
     -d "client_secret=$(cat ~/.google-ads/client-secret)" \
     -d "redirect_uri=http://localhost" \
     -d "grant_type=authorization_code"
   # Save the refresh_token from the JSON response
   ```
   Save the refresh token to `~/.google-ads/refresh-token`.
5. **Save member's Customer ID** — if `~/.google-ads/customer-id` doesn't exist yet, go to the MCC, find the member's subaccount, copy its Customer ID (digits only, no dashes), and save it to `~/.google-ads/customer-id`. If no subaccount exists for this member, follow Per-Member Setup (Setup Instructions above) first.
6. **Verify** — all 6 files should exist under `~/.google-ads/`.

### API Procedure

All API calls use REST (`https://googleads.googleapis.com/v17/`) with headers:
- `Authorization: Bearer <access_token>`
- `developer-token: <developer_token>`
- `login-customer-id: <mcc_id>`

**Step 1: Get access token**

Exchange the refresh token for an access token:

```bash
curl -s -X POST https://oauth2.googleapis.com/token \
  -d "refresh_token=$(cat ~/.google-ads/refresh-token)" \
  -d "client_id=$(cat ~/.google-ads/client-id)" \
  -d "client_secret=$(cat ~/.google-ads/client-secret)" \
  -d "grant_type=refresh_token"
```

Extract `access_token` from the JSON response.

**Step 2: Read member's customer account ID**

Read the member's subaccount Customer ID from the credential file:

```bash
cat ~/.google-ads/customer-id
```

This is the member's pre-existing subaccount (created once during Per-Member Setup). All MVPs for this member use the same account — campaigns are separated by name (`{idea.name}-search-v{N}`).

If `~/.google-ads/customer-id` does not exist, guide the user through Per-Member Setup (Setup Instructions above) to create their subaccount and save the Customer ID.

**Step 3: Create campaign budget**

```bash
curl -s -X POST "https://googleads.googleapis.com/v17/customers/<customer_id>/campaignBudgets:mutate" \
  -H "Authorization: Bearer <access_token>" \
  -H "developer-token: <developer_token>" \
  -H "login-customer-id: <mcc_id>" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"create": {"name": "<campaign_name>-budget", "amount_micros": <daily_budget_cents * 10000>, "delivery_method": "STANDARD"}}]}'
```

Extract the budget `resource_name` from the response.

**Step 4: Create campaign (PAUSED)**

```bash
curl -s -X POST "https://googleads.googleapis.com/v17/customers/<customer_id>/campaigns:mutate" \
  -H "Authorization: Bearer <access_token>" \
  -H "developer-token: <developer_token>" \
  -H "login-customer-id: <mcc_id>" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"create": {"name": "<campaign_name>", "status": "PAUSED", "advertising_channel_type": "SEARCH", "campaign_budget": "<budget_resource_name>", "start_date": "<YYYY-MM-DD>", "end_date": "<YYYY-MM-DD + duration_days>", "manual_cpc": {"enhanced_cpc_enabled": false}}}]}'
```

Extract the campaign `resource_name`.

**Step 5: Create ad group(s)**

One ad group per variant (if variants exist), otherwise a single ad group:

```bash
curl -s -X POST "https://googleads.googleapis.com/v17/customers/<customer_id>/adGroups:mutate" \
  -H "Authorization: Bearer <access_token>" \
  -H "developer-token: <developer_token>" \
  -H "login-customer-id: <mcc_id>" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"create": {"name": "<ad_group_name>", "campaign": "<campaign_resource_name>", "status": "ENABLED", "type": "SEARCH_STANDARD", "cpc_bid_micros": <max_cpc_cents * 10000>}}]}'
```

**Step 6: Add keywords**

For each keyword in ads.yaml `keywords` (exact, phrase, broad, negative):

```bash
curl -s -X POST "https://googleads.googleapis.com/v17/customers/<customer_id>/adGroupCriteria:mutate" \
  -H "Authorization: Bearer <access_token>" \
  -H "developer-token: <developer_token>" \
  -H "login-customer-id: <mcc_id>" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"create": {"ad_group": "<ad_group_resource_name>", "status": "ENABLED", "keyword": {"text": "<keyword>", "match_type": "<EXACT|PHRASE|BROAD>"}}}]}'
```

For negative keywords, use `negative: true` on the criterion.

**Step 7: Create responsive search ads**

For each ad in ads.yaml `ads` (or per ad group for variants):

```bash
curl -s -X POST "https://googleads.googleapis.com/v17/customers/<customer_id>/adGroupAds:mutate" \
  -H "Authorization: Bearer <access_token>" \
  -H "developer-token: <developer_token>" \
  -H "login-customer-id: <mcc_id>" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"create": {"ad_group": "<ad_group_resource_name>", "status": "ENABLED", "ad": {"responsive_search_ad": {"headlines": [{"text": "<headline>"}], "descriptions": [{"text": "<description>"}]}, "final_urls": ["<landing_url_with_utm>"]}}}]}'
```

**Step 8: Set location and language targeting**

```bash
curl -s -X POST "https://googleads.googleapis.com/v17/customers/<customer_id>/campaignCriteria:mutate" \
  -H "Authorization: Bearer <access_token>" \
  -H "developer-token: <developer_token>" \
  -H "login-customer-id: <mcc_id>" \
  -H "Content-Type: application/json" \
  -d '{"operations": [{"create": {"campaign": "<campaign_resource_name>", "location": {"geo_target_constant": "geoTargetConstants/2840"}}}, {"create": {"campaign": "<campaign_resource_name>", "language": {"language_constant": "languageConstants/1000"}}}]}'
```

`geoTargetConstants/2840` = United States, `languageConstants/1000` = English. Adjust based on ads.yaml `targeting.locations` and `targeting.languages`.

### Response Handling

- **Campaign ID**: extract from the campaign resource name — format is `customers/<customer_id>/campaigns/<campaign_id>`. The numeric `<campaign_id>` is what goes in ads.yaml.
- **Dashboard URL**: `https://ads.google.com/aw/campaigns?campaignId=<campaign_id>&ocid=<customer_id>`
- **Status**: campaign is created in `PAUSED` status — the user enables it after verifying conversion tracking.

### Error Handling

| Error | Cause | Action |
|-------|-------|--------|
| `OAUTH_TOKEN_INVALID` | Expired or revoked refresh token | Re-run Setup step 4 to generate a new refresh token |
| `DEVELOPER_TOKEN_NOT_APPROVED` | Developer token is pending review | Wait for Google approval (typically 1-3 business days), or use test account access |
| `BUDGET_AMOUNT_TOO_LARGE` | Daily budget exceeds account limits | Reduce `daily_budget_cents` in ads.yaml |
| `RESOURCE_ALREADY_EXISTS` | Campaign with same name already exists | Check if campaign was already created; if so, use existing campaign ID |
| `AUTHORIZATION_ERROR` | MCC doesn't have access to customer | Verify MCC ID is correct and has linked the customer account |
| Any other API error | Various | Report the full error message to the user and fall back to manual campaign creation (Step 9f) |
