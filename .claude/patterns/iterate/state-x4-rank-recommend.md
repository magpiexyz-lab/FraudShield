# STATE x4: RANK_AND_RECOMMEND

**PRECONDITIONS:**
- Scores computed (STATE x3 POSTCONDITIONS met)
- `.runs/iterate-cross-scores.json` exists

**ACTIONS:**

### Rank MVPs

Read `.runs/iterate-cross-scores.json`. Sort all MVPs:
1. NO-GO MVPs at the bottom (sorted alphabetically)
2. Scored MVPs sorted by `traction_score` descending

### Apply gate thresholds

For each scored MVP, assign a gate:

| Score Range | Gate | Meaning |
|------------|------|---------|
| > 65 | **GO** | Advance to Phase 2 |
| 45 - 65 | **CONDITIONAL** | Needs review before advancing |
| < 45 | **NO-GO** | Do not advance |

**Borderline handling:** If a score is within +/- 5 of a threshold boundary (i.e., 40-50 or 60-70), add a `borderline: true` flag and note "Recommend human review" in the output.

### Detect Broad Match fallback

For each MVP, check if Google Ads data shows Broad Match keywords (this indicates the campaign may have switched from Phrase Match during --check auto-fix, which inflates impressions but may lower quality). If detectable from the campaign data collected in STATE x1, add a `broad_match_fallback: true` flag. This serves as a data quality annotation, not a scoring penalty.

### Output ranking table

Present the evaluation to the Team Lead:

```
+=====================================================================+
|  Phase 1 Evaluation -- {date}  |  {N} MVPs  |  $100 x 7 days       |
+=====+=============+=======+=========+========+======+=====+=========+
| Rank| MVP         | Score | Signups | Active | CTR  | CPA | Gate    |
+-----+-------------+-------+---------+--------+------+-----+---------+
|  1  | {name}      | {sc}  | {d}/{c} | {a}/{d}| {ct}%| ${} | GO      |
|  2  | {name}      | {sc}  | {d}/{c} | {a}/{d}| {ct}%| ${} | GO      |
|  3  | {name}      | {sc}  | {d}/{c} | {a}/{d}| {ct}%| ${} | COND *  |
| ... |             |       |         |        |      |     |         |
|  N  | {name}      |  --   |  0/{c}  |  --    | 0.5% | --  | NO-GO   |
+-----+-------------+-------+---------+--------+------+-----+---------+
| * = borderline, recommend human review                              |
| BM = Broad Match fallback detected                                  |
+=====+=============+=======+=========+========+======+=====+=========+
```

Column definitions:
- **Rank**: by Traction Score descending (NO-GO MVPs unranked, shown at bottom)
- **Score**: Traction Score (0-100), `--` for Hard Gate NO-GO
- **Signups**: `demand_users / clicks` (signup rate from paid traffic)
- **Active**: `activate_users / demand_users` (activation rate)
- **CTR**: Google Ads click-through rate
- **CPA**: Cost Per Acquisition = `spend / demand_users` (cost per signup). `--` if demand = 0
- **Gate**: GO / COND / NO-GO

### Recommendations

After the table, provide actionable recommendations:

**GO MVPs (Score > 65):**
> **Recommendation: Advance [{names}] to Phase 2.**
> Phase 2: increase budget to $500, extend to 14 days, add conversion tracking optimization.
> Run `/distribute phase-2` on each GO MVP to generate the Phase 2 campaign config.

**CONDITIONAL MVPs (Score 45-65):**
For each CONDITIONAL MVP, provide a specific recommendation based on their weakest signal:
- Weak `conversion_signal` (< 50): "Low signup rate. Consider: optimize landing page copy, add social proof, simplify signup form."
- Weak `activation_signal` (< 30): "Users sign up but don't activate. Consider: simplify onboarding, add email nudge, reduce friction to core action."
- Weak `ctr_signal` (< 40): "Low CTR. Consider: rewrite ad copy to match search intent better, test new headlines."
- Weak `cost_signal` (< 30): "High cost per acquisition. Consider: add more negative keywords, lower bids on low-converting keywords."
- Borderline: "Score is near threshold boundary. Recommend extending Phase 1 by 3-5 days for more data before deciding."

**NO-GO MVPs:**
For each NO-GO MVP, explain which Hard Gate triggered:
- `zero_impressions`: "No search demand for these keywords. Consider pivoting the value proposition or targeting different keywords."
- `clicks_no_demand`: "Traffic exists but no signups. The landing page or product-market fit needs fundamental rework."
- `low_ctr`: "Ad copy/keywords mismatch. The search intent doesn't align with the product positioning."
- Score-based NO-GO (< 45): "Insufficient traction signals. Consider `/retro` to document learnings before moving on."

### Write report artifact

```bash
python3 -c "
import json
scores = json.load(open('.runs/iterate-cross-scores.json'))
report = {
    'date': '<ISO 8601>',
    'mvp_count': len(scores['scores']),
    'go_count': 0,
    'conditional_count': 0,
    'nogo_count': 0,
    'rankings': [],
    'phase2_candidates': []
}
for s in sorted(scores['scores'], key=lambda x: x.get('traction_score') or -1, reverse=True):
    gate = 'NO-GO'
    ts = s.get('traction_score')
    if s.get('hard_gate_result') == 'NO-GO':
        gate = 'NO-GO'
    elif ts is not None and ts > 65:
        gate = 'GO'
    elif ts is not None and ts >= 45:
        gate = 'CONDITIONAL'
    
    if gate == 'GO': report['go_count'] += 1; report['phase2_candidates'].append(s['name'])
    elif gate == 'CONDITIONAL': report['conditional_count'] += 1
    else: report['nogo_count'] += 1
    
    report['rankings'].append({'name': s['name'], 'score': ts, 'gate': gate})

json.dump(report, open('.runs/iterate-cross-report.json', 'w'), indent=2)
"
```

**POSTCONDITIONS:**
- Ranking table presented to Team Lead
- Actionable recommendations provided for each gate category
- `.runs/iterate-cross-report.json` exists

**VERIFY:**
```bash
test -f .runs/iterate-cross-report.json && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x4
```

**NEXT:** Read [state-x5-skill-epilogue.md](state-x5-skill-epilogue.md) to continue.
