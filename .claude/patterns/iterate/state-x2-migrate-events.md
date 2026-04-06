# STATE x2: MIGRATE_EVENTS

**PRECONDITIONS:**
- All data gathered (STATE x1 POSTCONDITIONS met)
- `.runs/iterate-cross-data.json` exists

**ACTIONS:**

### Check if migration is needed

Read `.runs/iterate-cross-data.json`. For each MVP, check `posthog.has_funnel_stage`:

- If **all** MVPs have `has_funnel_stage: true` (new MVPs bootstrapped after PR 4):
  > "All MVPs have funnel_stage data. Skipping event migration."
  Mark `has_funnel_stage: true` for all and proceed directly to STATE x3.

- If **some** MVPs have `has_funnel_stage: false` (old MVPs without typed wrappers):
  Continue with migration for those MVPs only.

### LLM funnel stage inference (for old MVPs)

For each MVP where `has_funnel_stage: false`:

1. Read the MVP's `posthog.raw_events` from the data file -- this is the list of distinct event names and their counts collected in STATE x1.

2. Infer `funnel_stage` for each event name. Use these mapping rules:

   | Pattern / Heuristic | funnel_stage |
   |---------------------|-------------|
   | `visit_*`, `page_view`, `$pageview`, view events | `reach` |
   | `signup_*`, `register_*`, `create_account`, `submit_*`, form submissions | `demand` |
   | `activate_*`, `first_*`, `complete_*`, core action events | `activate` |
   | `purchase_*`, `subscribe_*`, `payment_*`, `upgrade_*` | `monetize` |
   | `return_*`, `login` (non-first), `session_start` (returning) | `retain` |
   | `$autocapture`, `$pageleave`, system events | skip (not counted) |

3. Build the stage-to-count mapping:
   ```
   reach:    sum of unique_users for all reach-stage events
   demand:   sum of unique_users for all demand-stage events
   activate: sum of unique_users for all activate-stage events
   monetize: sum of unique_users for all monetize-stage events
   retain:   sum of unique_users for all retain-stage events
   ```

   **Important:** Use `count(DISTINCT distinct_id)` per stage, not sum of per-event counts (a user who triggers multiple reach events should count once for reach). Re-query PostHog if needed:

   ```bash
   POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key)
   curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $POSTHOG_API_KEY" \
     -d '{
       "query": {
         "kind": "HogQLQuery",
         "query": "SELECT '\''reach'\'' as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE event IN ({reach_events}) AND properties.project_name = {project_name} AND properties.utm_source = '\''google'\'' AND timestamp >= now() - INTERVAL 30 DAY UNION ALL SELECT '\''demand'\'' as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE event IN ({demand_events}) AND properties.project_name = {project_name} AND properties.utm_source = '\''google'\'' AND timestamp >= now() - INTERVAL 30 DAY",
         "values": {
           "project_name": "<mvp_name>",
           "reach_events": ["<event1>", "<event2>"],
           "demand_events": ["<event3>"]
         }
       }
     }'
   ```

4. Present the inferred mapping to the Team Lead for confirmation:
   ```
   Event mapping for {mvp_name} (inferred -- no funnel_stage property):

   | Event Name | Count | Inferred Stage |
   |-----------|-------|---------------|
   | {event} | {count} | {stage} |
   | ... |

   Resulting funnel: reach={N}, demand={N}, activate={N}, monetize={N}, retain={N}

   Does this mapping look correct? (Reply "yes" or provide corrections)
   ```

5. If the Team Lead provides corrections, update the mapping and re-query as needed.

### Update data file

Update `.runs/iterate-cross-data.json` -- for each migrated MVP:
- Set `posthog.reach`, `posthog.demand`, `posthog.activate`, `posthog.monetize`, `posthog.retain` with the inferred values
- Set `posthog.has_funnel_stage: true`
- Add `posthog.migration_method: "llm_inferred"` to distinguish from native funnel_stage data

**POSTCONDITIONS:**
- All MVPs in `.runs/iterate-cross-data.json` have `posthog.has_funnel_stage: true`
- Old MVPs have inferred funnel_stage counts confirmed by Team Lead
- Data file updated with migrated values

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data.json')); assert all('posthog' in m and m['posthog'].get('has_funnel_stage') for m in d['mvps']), 'not all MVPs have funnel_stage data'" && echo "OK" || echo "FAIL"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x2
```

**NEXT:** Read [state-x3-compute-scores.md](state-x3-compute-scores.md) to continue.
