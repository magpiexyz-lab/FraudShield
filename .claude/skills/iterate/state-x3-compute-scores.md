# STATE x3: COMPUTE_SCORES

**PRECONDITIONS:**
- All MVPs have funnel-stage data (STATE x2 POSTCONDITIONS met)
- Data integrity flags computed (STATE x1a POSTCONDITIONS met)
- `.runs/iterate-cross-data.json` exists with `tracking.signups` per MVP
- `.runs/iterate-cross-data-issues.json` exists with five issue flags per MVP

**ACTIONS:**

### Read inputs

```bash
DATA_FILE=.runs/iterate-cross-data.json
ISSUES_FILE=.runs/iterate-cross-data-issues.json
```

### Compute headline verdict (precedence-ordered)

For each MVP, apply the precedence rules in order. The first matching rule sets `headline_verdict`. Subsequent rules are skipped for that MVP.

| Order | Condition | Verdict | Notes |
|---|---|---|---|
| 1 | `bid_strategy_violation == true` | `STANDARD_VIOLATION` | Excluded from ranking. Owner must switch to Manual CPC. |
| 2 | `tracking_broken == true` | `TRACKING_BROKEN` | Excluded. Owner must debug PostHog gclid capture. |
| 3 | `not_deployed == true` | `NOT_DEPLOYED` | Excluded. Owner must deploy or fix PostHog snippet. |
| 4 | `tracking.signups >= config.thresholds.signups_go` (default 3) | `GO` | Sufficient signal. Eligible for Phase 2 promotion. |
| 5 | `google_ads.clicks >= config.thresholds.clicks_floor` (default 50) | `NO_GO` | Past data-floor without 3+ signups. Confidently rejected. |
| 6 | (default) | `INSUFFICIENT_DATA` | Need more data. Compute `clicks_needed = max(0, clicks_floor - clicks)`. |

`subaccount_conversion_misconfigured` is a **soft warning** — not a verdict. Carry it forward to x4 for display but don't change the verdict.

### Use the verdict module

The verdict precedence is implemented in `.claude/scripts/lib/iterate_cross_verdicts.py` for testability. Run it on the input files:

```bash
python3 .claude/scripts/lib/iterate_cross_verdicts.py \
  --data .runs/iterate-cross-data.json \
  --issues .runs/iterate-cross-data-issues.json \
  --config experiment/iterate-cross-config.yaml \
  --output .runs/iterate-cross-scores.json
```

The script reads inputs, applies the precedence rules above, computes `clicks_needed` for INSUFFICIENT_DATA verdicts, and writes the results.

### Optional: legacy Traction Score

If the user passes `--legacy-score` to the parent skill, the verdict module also computes the legacy Traction Score (Phase 1: 45% conversion + 25% CTR + 20% cost + 10% QS — see git history of this file for the formula). This is gated behind the flag because the weighted score misleads at the low data volumes typical of Phase 1; the simple 3/50 rule is the source of truth for default decisions.

### Schema of `.runs/iterate-cross-scores.json`

```json
{
  "thresholds": {"signups_go": 3, "clicks_floor": 50},
  "mvps": [
    {
      "name": "...",
      "owner": "...",
      "campaign_name": "...",
      "headline_verdict": "GO | NO_GO | INSUFFICIENT_DATA | STANDARD_VIOLATION | TRACKING_BROKEN | NOT_DEPLOYED",
      "clicks_needed": 0,
      "soft_warnings": ["subaccount_conversion_misconfigured" | "bid_strategy_unknown" | ...],
      "metrics": {
        "clicks": 41,
        "signups": 1,
        "conv_rate": 0.024,
        "ctr": 0.05,
        "spend": 72.68,
        "cpa": 72.68
      },
      "legacy_traction_score": null
    }
  ]
}
```

### Summary line

Print a one-line summary:

> Verdicts: {GO_count} GO · {NO_GO_count} NO-GO · {INSUFFICIENT_count} INSUFFICIENT · {STANDARD_VIOLATION_count} STANDARD_VIOLATION · {TRACKING_BROKEN_count} TRACKING_BROKEN · {NOT_DEPLOYED_count} NOT_DEPLOYED

**POSTCONDITIONS:**
- Every MVP has a `headline_verdict` (one of the 6 enum values)
- INSUFFICIENT_DATA MVPs have `clicks_needed` set
- `.runs/iterate-cross-scores.json` exists with the schema above

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x3`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-scores.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; allowed={'GO','NO_GO','INSUFFICIENT_DATA','STANDARD_VIOLATION','TRACKING_BROKEN','NOT_DEPLOYED'}; bad=[m.get('name','?') for m in ms if m.get('headline_verdict') not in allowed]; assert not bad, 'MVPs with invalid headline_verdict: %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x3
```

**NEXT:** Read [state-x4-rank-recommend.md](state-x4-rank-recommend.md) to continue.
