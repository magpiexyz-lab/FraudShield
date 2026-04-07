# STATE 1b: POLICY_CHECK

**PRECONDITIONS:**
- Channel selected (STATE 1a POSTCONDITIONS met)

**ACTIONS:**

> **Branch cleanup on failure:** Any "stop" in this step leaves you on a feature branch (created in Step 0). Include in the stop message: "To abort: `git checkout main && git branch -D chore/distribute`. To fix and retry: address the prerequisite, then re-run `/distribute`."

1. Read experiment.yaml `description`
2. Match against restricted-industry keywords: `crypto`, `DeFi`, `token`, `ICO`, `blockchain`, `NFT`, `yield`, `staking`, `liquidity`, `protocol`, `wallet`, `exchange`, `mining`, `DAO`
3. If match found, read the selected channel's "Policy Restrictions" section
4. If the channel restricts or bans the category, warn the user: "Your experiment mentions [keyword]. [Channel] [restricts/bans] this category: [details]. Consider switching to [alternative channels that allow it]."
5. Non-blocking — the user can confirm to proceed or switch channel

**POSTCONDITIONS:**
- Policy check completed (pass or user-confirmed)
- `.runs/distribute-preconditions.json` updated with `policy_checked: true`

Update the preconditions artifact:
```bash
python3 -c "
import json
p = json.load(open('.runs/distribute-preconditions.json'))
p['policy_checked'] = True
json.dump(p, open('.runs/distribute-preconditions.json', 'w'), indent=2)
"
```

**VERIFY:**
```bash
python3 -c "
import json; p=json.load(open('.runs/distribute-preconditions.json'))
assert p.get('policy_checked'), 'policy check skipped'
"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh distribute 1b
```

**NEXT:** Read [state-1c-analytics-config.md](state-1c-analytics-config.md) to continue.
