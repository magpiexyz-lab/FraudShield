# STATE c3: REPORT

**PRECONDITIONS:**
- Fixes processed (STATE c2 POSTCONDITIONS met)
- `.runs/iterate-check-fixes.json` exists

**ACTIONS:**

### Output health report

Read `.runs/iterate-check-context.json`, `.runs/iterate-check-health.json`, and `.runs/iterate-check-fixes.json`. Present a summary to the user:

```
## Campaign Health Check -- [campaign_name] -- Day [campaign_age_days]

**Status:** [Healthy / Issues Fixed / Needs Attention]

| Metric | Value |
|--------|-------|
| Impressions | [N] |
| Clicks | [N] |
| CTR | [X]% |
| Avg CPC | $[X] |
| Spend | $[X] of $[total_budget] |
| Conversions | [N] |

### Issues Found: [N]
[For each issue:]
- **[issue_type]**: [action_taken -- auto-fixed / needs manual intervention / recommendation]
  [description of what was done or recommended]

[If no issues:]
- No issues found. Campaign is running as expected.

### Thresholds Check
- Go signal: [thresholds.go_signal from ads.yaml]
- Current progress toward go signal: [assessment based on metrics]
- No-go signal: [thresholds.no_go_signal from ads.yaml]

### Next Steps
- Next health check: Day [campaign_age_days + 2] -- run `/iterate --check`
- For full funnel analysis: run `/iterate` (without --check) when you have enough conversion data
- If campaign was paused: review recommendations above before resuming
```

Determine the **Status** value:
- `Healthy` -- no issues found
- `Issues Fixed` -- issues found and all were auto-fixed
- `Needs Attention` -- issues found that require manual intervention (e.g., NO-GO signal, budget anomaly pause)

### Strategy B Skill Epilogue

Follow `.claude/patterns/skill-epilogue.md` **Strategy B** (Execution Audit).

Inputs for Strategy B:
- Context file: `.runs/iterate-check-context.json`
- Expected completed states: `["c0", "c1", "c2"]` (from state-registry.json agent_gates)
- This skill is analysis-only and makes no code changes (Chrome MCP actions on Google Ads UI are not code changes)

**Important:** When writing `observe-result.json`, use `"skill": "iterate-check"` (not `"iterate"`).

**POSTCONDITIONS:**
- Health report presented to user
- `.runs/observe-result.json` exists with `"skill": "iterate-check"`

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/observe-result.json')); assert d['skill']=='iterate-check'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-check c3
```

**NEXT:** TERMINAL -- ads health check complete.
