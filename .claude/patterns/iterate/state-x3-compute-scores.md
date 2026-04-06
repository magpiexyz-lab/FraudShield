# STATE x3: COMPUTE_SCORES

**PRECONDITIONS:**
- All data collected and standardized (STATE x2 POSTCONDITIONS met)
- `.runs/iterate-cross-data.json` exists with funnel_stage data for all MVPs

**ACTIONS:**

### Apply Hard Gates

For each MVP, check the following conditions **in order**. If any Hard Gate triggers, the MVP gets that gate result and skips scoring:

| # | Condition | Result | Rationale |
|---|-----------|--------|-----------|
| 1 | `impressions == 0` (after all Google Ads fallbacks) | **NO-GO** | Zero search demand for these keywords |
| 2 | `clicks >= 50` AND `demand == 0` (demand_users from PostHog) | **NO-GO** | Traffic exists but zero intent signal -- messaging or product mismatch |
| 3 | `ctr < 0.01` (1%) | **NO-GO** | Ad copy or keywords fundamentally misaligned with search intent |
| 4 | `demand >= 3` (demand_users from PostHog) | **GO** | Minimum viable traction signal achieved |

- Hard Gate 4 (GO) means the MVP has cleared the minimum bar but still gets a Traction Score for ranking
- Hard Gates 1-3 (NO-GO) bypass scoring entirely

### Compute Traction Score

For each MVP **not** eliminated by Hard Gates 1-3, compute the Traction Score:

```python
# Input signals
demand_users = posthog['demand']       # users who signed up / submitted form
activate_users = posthog['activate']   # users who completed core action
clicks = google_ads['clicks']
ctr = google_ads['ctr']                # as decimal (e.g., 0.035)
spend = google_ads['spend']            # total spend in dollars
quality_score = google_ads['quality_score']  # 1-10 scale, 0 if unavailable

# Industry average CTR (default 2.5% for SaaS/general search)
industry_avg_ctr = 0.025

# Signal computation
conversion_signal = min(demand_users * 25, 100)
activation_signal = min((activate_users / max(demand_users, 1)) * 100, 100)
ctr_signal = min((ctr / industry_avg_ctr) * 50, 100)
cost_signal = max(100 - (spend / max(demand_users, 1) / 50 * 100), 0)
qs_signal = quality_score * 10

# Weighted score
if quality_score > 0:
    # Standard weights
    score = (conversion_signal * 0.35 +
             activation_signal * 0.20 +
             ctr_signal * 0.20 +
             cost_signal * 0.15 +
             qs_signal * 0.10)
else:
    # QS fallback: redistribute QS weight to conversion and CTR
    score = (conversion_signal * 0.40 +
             activation_signal * 0.20 +
             ctr_signal * 0.25 +
             cost_signal * 0.15)
```

**Signal explanations:**
- `conversion_signal` (35%): Raw demand signal. Each signup worth 25 points, capped at 100. Highest weight because demand is the primary experiment signal.
- `activation_signal` (20%): Signup-to-activation ratio. Measures product quality after the landing page.
- `ctr_signal` (20%): CTR relative to industry average. Measures ad/keyword relevance.
- `cost_signal` (15%): Cost efficiency. Lower cost per demand user is better. $50/signup = 0 points.
- `qs_signal` (10%): Google's Quality Score reflects ad relevance, landing page experience, and expected CTR. Set to 0 if data insufficient (triggers fallback weights).

### Write scores

```bash
python3 -c "
import json

data = json.load(open('.runs/iterate-cross-data.json'))
scores = []

for mvp in data['mvps']:
    ga = mvp['google_ads']
    ph = mvp['posthog']

    result = {
        'name': mvp['name'],
        'deploy_url': mvp['deploy_url'],
        'hard_gate': None,
        'hard_gate_result': None,
        'traction_score': None,
        'signals': {},
        'qs_fallback': False
    }

    # Hard Gates
    if ga['impressions'] == 0:
        result['hard_gate'] = 'zero_impressions'
        result['hard_gate_result'] = 'NO-GO'
    elif ga['clicks'] >= 50 and ph.get('demand', 0) == 0:
        result['hard_gate'] = 'clicks_no_demand'
        result['hard_gate_result'] = 'NO-GO'
    elif ga['ctr'] < 0.01:
        result['hard_gate'] = 'low_ctr'
        result['hard_gate_result'] = 'NO-GO'
    elif ph.get('demand', 0) >= 3:
        result['hard_gate'] = 'min_demand_met'
        result['hard_gate_result'] = 'GO'

    # Compute score for non-NO-GO MVPs
    if result['hard_gate_result'] != 'NO-GO':
        demand = ph.get('demand', 0)
        activate = ph.get('activate', 0)
        ctr = ga['ctr']
        spend = ga['spend']
        qs = ga['quality_score']

        conv_s = min(demand * 25, 100)
        activ_s = min((activate / max(demand, 1)) * 100, 100)
        ctr_s = min((ctr / 0.025) * 50, 100)
        cost_s = max(100 - (spend / max(demand, 1) / 50 * 100), 0)
        qs_s = qs * 10

        if qs > 0:
            score = conv_s*0.35 + activ_s*0.20 + ctr_s*0.20 + cost_s*0.15 + qs_s*0.10
        else:
            score = conv_s*0.40 + activ_s*0.20 + ctr_s*0.25 + cost_s*0.15
            result['qs_fallback'] = True

        result['traction_score'] = round(score, 1)
        result['signals'] = {
            'conversion': round(conv_s, 1),
            'activation': round(activ_s, 1),
            'ctr': round(ctr_s, 1),
            'cost': round(cost_s, 1),
            'quality_score': round(qs_s, 1) if qs > 0 else None
        }

    scores.append(result)

json.dump({'scores': scores, 'industry_avg_ctr': 0.025}, open('.runs/iterate-cross-scores.json', 'w'), indent=2)
"
```

**POSTCONDITIONS:**
- Every MVP has either a Hard Gate result (NO-GO/GO) or a computed Traction Score
- `.runs/iterate-cross-scores.json` exists with scores for all MVPs

**VERIFY:**
```bash
test -f .runs/iterate-cross-scores.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x3
```

**NEXT:** Read [state-x4-rank-recommend.md](state-x4-rank-recommend.md) to continue.
