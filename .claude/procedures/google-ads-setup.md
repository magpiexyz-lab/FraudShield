# Google Ads Setup Guide

One-time setup for the team. After this, each team member gets a child account under the MCC, and all their MVPs share that account.

## Account Structure

```
MCC (Manager Account)
  alice-ads (member account — Alice)
  bob-ads (member account — Bob)
  ... (one per team member; each member runs all their MVPs here)
```

### Naming conventions

- MCC: `{team-name} Experiments`
- Child accounts: `{member-name}-ads`
- Campaigns: `{idea.name}-search-v{N}`
- Conversion actions: `{idea.name}-activate`, `{idea.name}-signup`

## Step 1: Create Google Ads MCC

1. Go to ads.google.com/home/tools/manager-accounts
2. Click "Create a manager account"
3. Name it `{team-name} Experiments`
4. Set time zone and currency

The MCC lets you manage billing centrally and create child accounts per team member.

## Step 2: Add Billing

1. In the MCC, go to Billing -> Settings
2. Add a credit card
3. All child accounts inherit this billing method

## Step 3: Apply for API Developer Token

This is only needed for Phase 2 (automated campaign creation). Phase 1 works without it.

1. In the MCC, go to Tools & Settings -> API Center
2. Click "Apply for access"
3. Fill in the application (describe it as "automated campaign management for A/B testing")
4. Approval takes 3-14 business days
5. You'll receive a developer token once approved

## Step 4: Create Google Cloud Project (Phase 2 only)

1. Go to console.cloud.google.com
2. Create a new project: `{team-name}-ads-automation`
3. Enable the Google Ads API
4. Create OAuth 2.0 credentials (Web application type)
5. Download the credentials JSON
6. Store securely — never commit to the repo

## Step 5: Create a Child Account for a Team Member

Do this once per team member (not per MVP):

1. In the MCC, click "Create new account"
2. Select "Create a new Google Ads account" (not "Link an existing account")
3. Name it `{member-name}-ads`
4. It inherits billing from the MCC — do not add a separate payment method to the child account
5. Complete Advertiser Verification when prompted — this is per-account, so it only needs to be done once per member
6. Note the account's Customer ID (format: XXX-XXX-XXXX) — save it to `~/.google-ads/customer-id` (digits only, no dashes)

All MVPs for this member will use this same account. Separate MVPs by campaigns (naming: `{idea.name}-search-v{N}`).

## Step 6: Set Up Offline Conversion Import

In the member's child account, for each MVP:

1. Go to Tools & Settings -> Conversions -> New conversion action
2. Select "Import" -> "Other data sources or CRMs"
3. Create two conversion actions:
   - `{idea.name}-activate` (primary, category: Purchase/Sale)
   - `{idea.name}-signup` (secondary, category: Sign-up)
4. Set the conversion window to match `budget.duration_days` from ads.yaml

## Step 7: Connect Analytics Provider to Google Ads

> The steps below use PostHog as an example. Adapt to your analytics provider.

1. In your analytics provider, go to Data pipelines / Destinations
2. Add "Google Ads Offline Conversions" destination
3. Authenticate with the Google account that owns the MCC
4. Map analytics events to Google Ads conversion actions:
   - `activate` -> `{idea.name}-activate`
   - `signup_complete` -> `{idea.name}-signup`
5. Use `gclid` from event properties as the click identifier
6. Test with a manual conversion to verify the pipeline

## Phase 2: API Automation

After the developer token is approved:

1. Store these environment variables securely (not in the repo):
   - `GOOGLE_ADS_DEVELOPER_TOKEN`
   - `GOOGLE_ADS_CLIENT_ID`
   - `GOOGLE_ADS_CLIENT_SECRET`
   - `GOOGLE_ADS_REFRESH_TOKEN`
   - `GOOGLE_ADS_MCC_ID`

2. The `/distribute` skill will gain a `--launch` flag to create campaigns directly via the API
3. Auto-pause rules from `ads.yaml` will be enforced via scheduled scripts
