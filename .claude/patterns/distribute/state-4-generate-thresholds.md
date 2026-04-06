# STATE 4: GENERATE_THRESHOLDS

**PRECONDITIONS:**
- Ad creative generated (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

### Phase-aware defaults

Read `phase` from `.runs/distribute-context.json`:
```bash
PHASE=$(python3 -c "import json; print(json.load(open('.runs/distribute-context.json')).get('phase', 1))")
```

Apply phase-specific budget and duration defaults:

| Setting | Phase 1 | Phase 2 | No phase (legacy) |
|---------|---------|---------|-------------------|
| `duration_days` | 7 | 14 | 14 |
| `total_budget_cents` | 10000 ($100) | 50000 ($500) | 10000 ($100) |
| `daily_budget_cents` | ~1429 ($14.29/day) | ~3571 ($35.71/day) | ~714 ($7.14/day) |

These are defaults — if experiment.yaml or user input specifies different values, those take precedence.

Read the channel's stack file "Cost Model" section to understand the pricing model, then use first-principles reasoning specific to this MVP:

**For CPC channels (e.g., google-ads):**
1. Parse `budget.total_budget_cents` and estimate CPC for the targeting category
2. Calculate: expected clicks = budget / CPC
3. Estimate funnel conversion rates:
   - Landing → signup: 5-15% for cold paid traffic
   - Signup → activate: 20-40% depending on activation friction
4. Calculate expected volume at each stage

**For CPM channels (e.g., twitter, reddit):**
1. Parse `budget.total_budget_cents` and estimate CPM for the targeting category
2. Calculate: expected impressions = budget / (CPM / 1000)
3. Calculate: expected clicks = impressions × estimated CTR
4. Estimate funnel conversion rates (same as above)
5. Calculate expected volume at each stage

Show the reasoning chain, not just the numbers:

```
## Threshold Reasoning

Budget: $100 over 7 days
Estimated [CPC/CPM] for [targeting category]: ~$X.XX
Expected [clicks/impressions]: [calculation]
Expected signups: [clicks * landing-to-signup rate] ([rate]% — [reasoning])
Expected activations: [signups * signup-to-activate rate] ([rate]% — [reasoning])

Go signal: [N]+ activations from paid traffic within experiment timeline
No-go signal: 0 activations after $[half-budget] spend, or <1% CTR after 500 impressions
```

4. Define go/no-go signals based on experiment.yaml `thesis` and `funnel` thresholds

### Schema rules for ads.yaml
- `channel`: the selected distribution channel (e.g., `google-ads`, `twitter`, `reddit`)
- `campaign_name`: auto-generated following the channel's config schema pattern (e.g., `{project-name}-search-v{N}` for google-ads, `{project-name}-twitter-v{N}` for twitter)
- `budget.total_budget_cents`: Phase 1 default 10000 ($100), Phase 2 default 50000 ($500). Max 50000 without explicit override.
- `budget.duration_days`: Phase 1 default 7 days, Phase 2 default 14 days. Overridable by user.
- `guardrails`: channel-specific — CPC channels require `max_cpc_cents`; other channels may use `max_cpe_cents` or just `auto_pause_rules`
- `thresholds`: AI-generated from experiment.yaml context using first-principles reasoning

**POSTCONDITIONS:**
- Threshold reasoning chain documented with calculations
- Go/no-go signals defined based on experiment thesis
- Budget, duration, guardrails, and thresholds determined per schema rules

**VERIFY:**
```bash
grep -q 'thresholds:' experiment/ads.yaml 2>/dev/null || grep -q 'budget:' experiment/ads.yaml 2>/dev/null
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 4
```

**NEXT:** Read [state-5-generate-ads-yaml.md](state-5-generate-ads-yaml.md) to continue.
