# STATE x3: COMPUTE_SCORES

Pure compute: read per-MVP `signups` + `gclid_visitors` from data.json, apply 3/50 rule, write scores.json.

**PRECONDITIONS:**
- STATE x2 POSTCONDITIONS met
- `.runs/iterate-cross-data.json` exists with `signups` and `gclid_visitors` per MVP
- `.runs/iterate-cross-data-issues.json` exists with `low_traffic`, `no_event_data` flags

**ACTIONS:**

### Compute headline verdict (precedence-ordered)

For each MVP, apply rules in order. The first matching rule sets `headline_verdict`:

| Order | Condition | Verdict | Notes |
|---|---|---|---|
| 1 | `no_event_data == true` | `NO_DATA` | Discovered MVP but no PostHog events found. Likely tracking not deployed. |
| 2 | `signups >= thresholds.signups_go` (default 3) | `GO` | Sufficient signal. Eligible for Phase 2 promotion. |
| 3 | `gclid_visitors >= thresholds.visitors_floor` (default 50) AND `signups == 0` | `NO_GO` | Past data-floor with zero conversion. Reject. |
| 4 | `gclid_visitors >= thresholds.visitors_floor` AND `0 < signups < signups_go` | `WEAK` | Above visitors floor with some signal but below GO threshold. Decide case-by-case. |
| 5 | (default) | `INSUFFICIENT_DATA` | Below visitors floor, can't conclude. Compute `visitors_needed = max(0, visitors_floor - gclid_visitors)`. |

### Use the verdict module

Verdict precedence is implemented in `.claude/scripts/lib/iterate_cross_verdicts.py` for testability:

```bash
python3 .claude/scripts/lib/iterate_cross_verdicts.py \
  --data .runs/iterate-cross-data.json \
  --issues .runs/iterate-cross-data-issues.json \
  --config experiment/iterate-cross-config.yaml \
  --output .runs/iterate-cross-scores.json
```

The script reads inputs, applies the precedence rules above, computes `visitors_needed` for INSUFFICIENT_DATA verdicts, and writes the results.

### Schema of `.runs/iterate-cross-scores.json`

```json
{
  "thresholds": {"signups_go": 3, "visitors_floor": 50},
  "window_days": 90,
  "mvps": [
    {
      "name": "diarly",
      "owner": "lego",
      "headline_verdict": "GO | WEAK | NO_GO | INSUFFICIENT_DATA | NO_DATA",
      "visitors_needed": 0,
      "metrics": {
        "gclid_visitors": 100,
        "signups": 8,
        "conv_rate": 0.08
      },
      "signup_events": ["signup_complete"]
    }
  ]
}
```

### Summary line

Print to stdout:
> Verdicts: {GO} GO · {WEAK} WEAK · {NO_GO} NO_GO · {INSUF} INSUFFICIENT · {NO_DATA} NO_DATA

**POSTCONDITIONS:**
- Every MVP has `headline_verdict` (one of: GO, WEAK, NO_GO, INSUFFICIENT_DATA, NO_DATA)
- INSUFFICIENT_DATA MVPs have `visitors_needed` set
- `.runs/iterate-cross-scores.json` exists with the schema above

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x3`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-scores.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; allowed={'GO','WEAK','NO_GO','INSUFFICIENT_DATA','NO_DATA'}; bad=[m.get('name','?') for m in ms if m.get('headline_verdict') not in allowed]; assert not bad, 'MVPs with invalid headline_verdict: %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x3
```

**NEXT:** Read [state-x4-rank-recommend.md](state-x4-rank-recommend.md) to continue.
