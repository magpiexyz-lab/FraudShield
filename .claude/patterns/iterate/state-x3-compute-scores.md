# STATE x3: COMPUTE_SCORES

**PRECONDITIONS:**
- All MVPs have standardized funnel stage data (STATE x2 POSTCONDITIONS met)
- `.runs/iterate-cross-data.json` exists with `google_ads` + `posthog` data per MVP

**ACTIONS:**

### Read data

Read `.runs/iterate-cross-data.json` and extract each MVP's metrics.

### Apply Hard Gates

For each MVP, check hard gate conditions **in order**. The first matching condition determines the verdict -- stop checking once a gate fires.

| # | Condition | Verdict | Reason |
|---|-----------|---------|--------|
| 1 | `impressions == 0` (after all data fallbacks) | NO-GO | No ad delivery -- campaign misconfigured or policy issue |
| 2 | `clicks >= 50` AND `demand_users == 0` | NO-GO | Traffic arrived but zero conversion signal -- value prop rejected |
| 3 | `CTR < 1%` (i.e., `ctr < 0.01`) | NO-GO | Ad copy / keyword mismatch -- audience not responding |
| 4 | `demand_users >= 3` | GO | Minimum viable signal detected -- proceed to scoring |

MVPs that match NO-GO are excluded from scoring. Record the gate reason.

MVPs that match GO proceed to Traction Score calculation.

MVPs that match **none** of the gates also proceed to scoring (they have some data but don't hit any hard threshold).

### Compute Traction Score

Traction Score is **phase-aware** — each phase uses different signals based on
available data volume. Read `phase` from the `--cross` arguments or default to 1.

For each MVP not eliminated by hard gates:

```
# Extract values
demand_users   = posthog.demand
activate_users = posthog.activate
ctr            = google_ads.ctr          # as decimal (e.g., 0.035)
spend          = google_ads.spend        # in dollars
quality_score  = google_ads.quality_score # 1-10 scale, or 0 if unavailable

# Industry average CTR default
industry_avg_ctr = 0.025  # 2.5%

# Signal calculations (shared across phases)
conversion_signal = min(demand_users * 25, 100)
activation_signal = min((activate_users / max(demand_users, 1)) * 100, 100)
ctr_signal        = min((ctr / industry_avg_ctr) * 50, 100)
cost_signal       = max(100 - (spend / max(demand_users, 1) / 50 * 100), 0)
qs_signal         = quality_score * 10
```

#### Phase 1 weights ($140/7 days — activation data too sparse to be reliable)

Phase 1 does NOT include activation_signal. With only 1-5 signups expected,
activation would be 0-2 data points — pure noise at 20% weight.

**Standard** (when `quality_score > 0`):
```
score = conversion_signal * 0.45
      + ctr_signal        * 0.25
      + cost_signal       * 0.20
      + qs_signal         * 0.10
```

**QS fallback** (when `quality_score == 0`):
```
score = conversion_signal * 0.50
      + ctr_signal        * 0.30
      + cost_signal       * 0.20
```

#### Phase 2 weights ($500/14 days — activation becomes reliable)

**Standard** (when `quality_score > 0`):
```
score = conversion_signal * 0.30
      + activation_signal * 0.25
      + ctr_signal        * 0.20
      + cost_signal       * 0.15
      + qs_signal         * 0.10
```

**QS fallback** (when `quality_score == 0`):
```
score = conversion_signal * 0.35
      + activation_signal * 0.25
      + ctr_signal        * 0.25
      + cost_signal       * 0.15
```

#### Phase 3 weights ($1000+/ongoing — monetization data available)

Phase 3 adds monetization and retention signals. These replace the simpler
cost/CTR signals that matter less at scale.

```
monetize_users = posthog.monetize
retain_users   = posthog.retain
monetization_signal = min((monetize_users / max(demand_users, 1)) * 200, 100)
retention_signal    = min((retain_users / max(activate_users, 1)) * 100, 100)
roas_signal         = min((revenue / max(spend, 1)) * 50, 100)  # revenue from PostHog pay events
```

```
score = conversion_signal    * 0.15
      + activation_signal    * 0.20
      + monetization_signal  * 0.25
      + roas_signal          * 0.25
      + retention_signal     * 0.15
```

### Write scores file

```bash
python3 -c "
import json

scores = {
    'industry_avg_ctr': 0.025,
    'mvps': [
        # For each MVP:
        # {
        #     'name': 'pettracker',
        #     'hard_gate': None or {'verdict': 'NO-GO', 'reason': '...', 'gate_number': N},
        #     'signals': {
        #         'conversion_signal': 75.0,
        #         'activation_signal': 50.0,
        #         'ctr_signal': 70.0,
        #         'cost_signal': 60.0,
        #         'qs_signal': 70.0
        #     },
        #     'weights_mode': 'standard' or 'qs_fallback',
        #     'traction_score': 65.5
        # }
    ]
}
json.dump(scores, open('.runs/iterate-cross-scores.json', 'w'), indent=2)
"
```

Replace placeholder data with actual computed values.

**POSTCONDITIONS:**
- Every MVP has either a hard gate verdict (NO-GO/GO) or a computed Traction Score
- Signal breakdowns recorded for transparency
- `.runs/iterate-cross-scores.json` exists

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-scores.json')); assert d.get('industry_avg_ctr',0)>0, 'industry_avg_ctr missing'; ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; [None for m in ms if m.get('hard_gate') is None and m.get('traction_score') is None and (_ for _ in ()).throw(AssertionError('%s has neither hard_gate nor traction_score' % m.get('name','')))]"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x3
```

**NEXT:** Read [state-x4-rank-recommend.md](state-x4-rank-recommend.md) to continue.
