# STATE x1a: VALIDATE_DATA_INTEGRITY

## Archetype Gate

This state validates Google Ads + PostHog data quality for cross-MVP comparison. Cross-MVP analytics applies to **all archetypes** but the data sources differ:

REF: [.claude/patterns/archetype-behavior-check.md](../../patterns/archetype-behavior-check.md) — row "primary unit"

> [primary-unit] web-app: page | service: endpoint | cli: command

For all archetypes, this state operates on Google Ads campaign data + PostHog event data — both are archetype-agnostic. The bid_strategy_violation, tracking_broken, not_deployed, name_mapping checks apply uniformly. No archetype-specific branching in this state.

**PRECONDITIONS:**
- STATE x1 POSTCONDITIONS met
- `.runs/iterate-cross-data.json` exists with extended schema (per-MVP `google_ads.bid_strategy_type`, `tracking.gclid_visitor_count`, `tracking.total_events_count`, `tracking.signups`, `subaccount_default_conversion_action`)
- `experiment/iterate-cross-config.yaml` exists OR defaults will be used (notice already emitted by x1)

**ACTIONS:**

This state is **pure compute** — no network calls. Idempotent. Safe to re-run after editing the operator config without re-running x1.

### Read inputs

```bash
python3 -c "
import json, os, sys, yaml

data = json.load(open('.runs/iterate-cross-data.json'))

config_path = 'experiment/iterate-cross-config.yaml'
if os.path.exists(config_path):
    config = yaml.safe_load(open(config_path)) or {}
else:
    config = {}

# Defaults (must mirror x1's defaults for consistency)
defaults = {
    'signup_whitelist': ['signup_complete','waitlist_signup','waitlist_submit','early_access_signup','activate'],
    'conversion_action_whitelist': ['Sign-up','MVP Signup','Submit lead form','Sign-ups'],
    'mvp_mappings': {},
    'thresholds': {'signups_go': 3, 'clicks_floor': 50, 'click_window_days': 7},
}
for key, default_value in defaults.items():
    config.setdefault(key, default_value)
"
```

### Compute issue flags per MVP

For each MVP in `data['mvps']`, compute the following five flags. Each flag is `true` / `false`. An MVP can have multiple flags simultaneously.

#### 1. `bid_strategy_violation`

```
bid_strategy_violation = (mvp.google_ads.bid_strategy_type != 'manual_cpc')
                         AND (mvp.google_ads.bid_strategy_unknown != true)
```

If `bid_strategy_unknown` is true, set `bid_strategy_violation: false` and `bid_strategy_unknown: true` separately (this is a data-quality issue, not a violation).

#### 2. `tracking_broken`

```
tracking_broken = (mvp.google_ads.clicks > 0)
                 AND (mvp.tracking.gclid_visitor_count == 0)
                 AND (mvp.tracking.total_events_count > 0)
```

The MVP is firing PostHog events but none have a gclid. Frontend gclid capture is broken.

#### 3. `not_deployed`

```
not_deployed = (mvp.google_ads.clicks > 0)
              AND (mvp.tracking.total_events_count == 0)
```

PostHog has zero events for this domain in the time window — the MVP is either not deployed or has no PostHog snippet. Distinct from `tracking_broken`.

#### 4. `subaccount_conversion_misconfigured`

```
default_action = mvp.subaccount_default_conversion_action
matches_whitelist = any(default_action.lower() == w.lower() for w in config.conversion_action_whitelist)
                    OR any(w.lower() in default_action.lower() for w in config.conversion_action_whitelist)
subaccount_conversion_misconfigured = (default_action is not None) AND (not matches_whitelist)
```

Soft warn — doesn't exclude from scoring. Sub-account default conversion action is not in the operator's whitelist (e.g., it's "Page view" instead of "Sign-up").

If `default_action is None` (couldn't read), set `subaccount_conversion_unknown: true` and don't flag as misconfigured.

#### 5. `name_mapping_low_confidence`

For each MVP, compute fuzzy match between `campaign_name` and `name`:

```python
import difflib

def normalize(s):
    return s.lower().replace('-search-v1', '').replace('_search_v1', '').replace('-search-v2', '').replace('_search_v2', '').replace('-manual', '').strip()

confidence = difflib.SequenceMatcher(None, normalize(mvp['campaign_name']), normalize(mvp['name'])).ratio()

# Override from config takes precedence
if mvp['campaign_name'] in config['mvp_mappings']:
    confidence = 1.0  # operator confirmed
    mapping_source = 'operator_override'
else:
    mapping_source = 'auto_fuzzy'

name_mapping_low_confidence = (confidence < 0.85) AND (mapping_source == 'auto_fuzzy')
```

### Interactive low-confidence mapping confirmation

If any MVP has `name_mapping_low_confidence: true`, present a confirmation table to the user:

> The following MVPs have low-confidence campaign-to-project_name mapping. Please confirm or override:
>
> | Campaign name | Best PostHog match | Confidence | Alternatives |
> |---|---|---|---|
> | autodropship-search-v1 | dropship-ops | 0.62 | dropship-ai (0.28), autodrop (0.10) |
> | ... |
>
> For each row, choose: **accept** the suggested match, **override** with a different project_name, or **abort**.

Wait for user input. For each accepted/overridden mapping:
1. Update the MVP's `name_mapping_low_confidence: false` and `mapping_source: 'operator_override'`
2. Persist to `experiment/iterate-cross-config.yaml` under `mvp_mappings`:

```yaml
mvp_mappings:
  autodropship-search-v1:
    posthog_project_name: dropship-ops
```

Re-running x1a after this point will treat the mapping as confirmed (confidence forced to 1.0).

### Decide skip_migration per MVP

For each MVP, set `skip_migration: true` if `tracking_broken` OR `not_deployed`. STATE x2 reads this flag and skips event-name migration for these MVPs (their event pool is empty by definition).

### Write issues file

```bash
python3 -c "
import json

issues = {
    'mvps': [
        # For each MVP:
        # {
        #     'name': 'pettracker',
        #     'bid_strategy_violation': false,
        #     'bid_strategy_unknown': false,
        #     'tracking_broken': false,
        #     'not_deployed': false,
        #     'subaccount_conversion_misconfigured': false,
        #     'subaccount_conversion_unknown': false,
        #     'name_mapping_low_confidence': false,
        #     'mapping_source': 'auto_fuzzy',  # or 'operator_override'
        #     'mapping_confidence': 1.0,
        #     'skip_migration': false
        # }
    ]
}
json.dump(issues, open('.runs/iterate-cross-data-issues.json', 'w'), indent=2)
"
```

### Summary report

Print a concise summary:

> Data integrity check: {N} MVPs validated.
> - {bv_count} bid_strategy_violation (excluded from ranking; operator must switch bid strategy)
> - {tb_count} tracking_broken (excluded; debug PostHog gclid capture)
> - {nd_count} not_deployed (excluded; deploy or fix PostHog snippet)
> - {cm_count} subaccount_conversion_misconfigured (soft warn; still scored)
> - {nm_count} name_mapping_low_confidence (resolved interactively or via config)

**POSTCONDITIONS:**
- Every MVP has all five issue flags computed (boolean fields)
- Low-confidence mappings confirmed by user and persisted to config
- `skip_migration` flag set on tracking_broken / not_deployed MVPs
- `.runs/iterate-cross-data-issues.json` exists with required schema

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x1a`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data-issues.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; req=['bid_strategy_violation','tracking_broken','not_deployed','subaccount_conversion_misconfigured','name_mapping_low_confidence','skip_migration']; bad=[m.get('name','?') for m in ms if any(k not in m for k in req)]; assert not bad, 'MVPs missing issue flags: %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x1a
```

**NEXT:** Read [state-x2-migrate-events.md](state-x2-migrate-events.md) to continue.
