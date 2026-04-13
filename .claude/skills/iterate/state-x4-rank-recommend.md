# STATE x4: RANK_AND_RECOMMEND

**PRECONDITIONS:**
- All scores computed (STATE x3 POSTCONDITIONS met)
- `.runs/iterate-cross-scores.json` exists
- `.runs/iterate-cross-data.json` exists (for raw metrics)

**ACTIONS:**

### Read data

Read `.runs/iterate-cross-scores.json` and `.runs/iterate-cross-data.json` for the full picture.

### Rank MVPs

1. Sort all MVPs by Traction Score in descending order
2. MVPs with hard gate NO-GO are placed at the bottom (no score)
3. MVPs with hard gate GO but no computed score are ranked by `demand_users` count

### Apply gate thresholds

For each scored MVP:

| Score Range | Gate | Meaning |
|------------|------|---------|
| > 65 | **GO** | Strong signal -- advance to Phase 2 |
| 45 -- 65 | **CONDITIONAL** | Mixed signal -- needs human judgment |
| < 45 | **NO-GO** | Weak signal -- do not advance |

**Borderline marking:** MVPs with scores within +/-5 of a threshold boundary (i.e., 40-50 or 60-70) are flagged as `borderline: true` -- these need human review.

### Detect Broad Match fallback

If visible in Google Ads data (Search Terms report or keyword match type column), note which MVPs used Broad Match keywords. Broad Match can inflate impressions/clicks with irrelevant traffic, making CTR and conversion metrics less reliable. Flag these MVPs with `broad_match_detected: true`.

### Output ranking table

Present the ranking to the Team Lead:

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║  Phase 1 Evaluation — {date}  |  {N} MVPs  |  ${budget} × {days} days       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║ Rank │ MVP         │ Score │ Signups │ Active  │ CTR   │ CPA   │ Gate       ║
║──────┼─────────────┼───────┼─────────┼─────────┼───────┼───────┼────────────║
║  1   │ {name}      │ {sc}  │ {d}/{c} │ {a}/{d} │ {ct}% │ ${cp} │ GO         ║
║  2   │ {name}      │ {sc}  │ {d}/{c} │ {a}/{d} │ {ct}% │ ${cp} │ CONDITIONAL║
║  3   │ {name}      │  --   │  0/{c}  │  --     │ {ct}% │  --   │ NO-GO (H2) ║
║  ...                                                                         ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║  Legend: Signups = demand/clicks, Active = activate/demand                    ║
║  CPA = spend / demand_users (cost per acquisition)                           ║
║  (Hn) = Hard Gate number that triggered NO-GO                                ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

Column definitions:
- **Score**: Traction Score (0-100), or `--` for hard-gated MVPs
- **Signups**: `demand_users / clicks` -- conversion from ad click to signup
- **Active**: `activate_users / demand_users` -- activation rate
- **CTR**: Google Ads click-through rate
- **CPA**: `spend / demand_users` -- cost per acquired user (dollars)
- **Gate**: GO / CONDITIONAL / NO-GO, with hard gate number if applicable

### Recommendations

**For GO MVPs:**
> "Advance **{names}** to Phase 2. These MVPs showed strong demand signal and efficient acquisition costs."

**For CONDITIONAL MVPs** -- give specific, actionable suggestions for each:
- If CTR is low but demand exists: "Optimize ad copy and keywords -- demand signal is there but ads aren't resonating"
- If CPA is high: "Test lower-cost channels or optimize landing page conversion rate before scaling"
- If activation is low: "Improve onboarding flow -- users are signing up but not activating"
- If borderline score: "Extend test by 7 days with optimized keywords for a clearer signal"
- If Broad Match detected: "Switch to Phrase/Exact match and re-test -- current metrics may be inflated by irrelevant traffic"

**For NO-GO MVPs:**
> "Do not advance. {specific reason based on which hard gate fired or low score}."

### Summary recommendation

> "**Recommendation:** Advance {N} of {total} MVPs to Phase 2: {list of GO MVPs}."
> "{N} CONDITIONAL MVPs need further evaluation. {N} NO-GO MVPs should be stopped."

**POSTCONDITIONS:**
- Ranking table presented to Team Lead
- Per-MVP gate assignments and recommendations provided
- Summary recommendation delivered

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-scores.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; scored=[m for m in ms if m.get('traction_score') is not None]; gated=[m for m in ms if m.get('hard_gate')]; assert len(scored)+len(gated)==len(ms), 'some MVPs have neither score nor gate'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x4
```

**NEXT:** Skill states complete.
