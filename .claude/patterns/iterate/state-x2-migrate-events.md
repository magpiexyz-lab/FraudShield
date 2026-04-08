# STATE x2: MIGRATE_EVENTS

**PRECONDITIONS:**
- PostHog data gathered (STATE x1 POSTCONDITIONS met)
- `.runs/iterate-cross-data.json` exists with `has_funnel_stage` flag per MVP

**ACTIONS:**

### Check if migration is needed

Read `.runs/iterate-cross-data.json`. Check each MVP's `has_funnel_stage` field.

- If **all** MVPs have `has_funnel_stage: true` → skip this state entirely. Write no new files, proceed directly to POSTCONDITIONS.
- If **any** MVP has `has_funnel_stage: false` → proceed with migration for those MVPs only.

### For each MVP without funnel_stage

#### Step 1: Query distinct event names

```bash
POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key)
POSTHOG_PROJECT_ID=$(curl -s "https://us.i.posthog.com/api/projects/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")

curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT event, count(*) as event_count FROM events WHERE properties.$current_url LIKE {url_pattern} AND timestamp >= {start_date} GROUP BY event ORDER BY event_count DESC",
      "values": {
        "url_pattern": "%<deploy_domain>%",
        "start_date": "<campaign_start_date ISO>"
      }
    }
  }'
```

#### Step 2: LLM funnel_stage inference

Read the event name list. For each event, infer the funnel_stage based on the event name semantics:

| Funnel Stage | Typical Event Names |
|-------------|-------------------|
| `reach` | `$pageview`, `visit_landing`, `page_view`, any landing/visit event |
| `demand` | `signup_start`, `signup_complete`, `create_account`, `register`, `submit_email`, `waitlist_join` |
| `activate` | `first_action`, `complete_onboarding`, `create_first_*`, `use_feature`, `activate_*` |
| `monetize` | `payment_start`, `payment_complete`, `subscribe`, `checkout_*`, `purchase_*` |
| `retain` | `return_visit`, `day_7_active`, `second_session`, `repeat_*` |

Events that don't map to any stage (e.g., `$pageleave`, `$autocapture`, internal PostHog events) should be excluded from the funnel.

#### Step 3: Re-query PostHog with inferred mapping

For each mapped event, query its unique user count:

```bash
curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  -d '{
    "query": {
      "kind": "HogQLQuery",
      "query": "SELECT {mapped_events_case_expression} as stage, count(DISTINCT distinct_id) as unique_users FROM events WHERE properties.$current_url LIKE {url_pattern} AND event IN {event_list} AND timestamp >= {start_date} GROUP BY stage",
      "values": {
        "url_pattern": "%<deploy_domain>%",
        "event_list": ["event1", "event2"],
        "start_date": "<campaign_start_date ISO>"
      }
    }
  }'
```

Alternatively, query each event separately and aggregate by inferred stage locally.

#### Step 4: Confirm mapping with Team Lead

Present the inferred mapping for each old MVP:

> **Event migration for {mvp_name}:**
>
> | Event Name | Inferred Stage | Count |
> |-----------|---------------|-------|
> | `$pageview` | reach | 342 |
> | `signup_complete` | demand | 12 |
> | ... |
>
> Does this mapping look correct? (Adjust if needed)

Wait for confirmation. Adjust mapping if the Team Lead provides corrections.

### Update data file

After migration, update `.runs/iterate-cross-data.json`:
- Replace each migrated MVP's `posthog` field with the newly aggregated funnel stage counts
- Set `has_funnel_stage: true` and `data_source: "inferred"` for migrated MVPs

**POSTCONDITIONS:**
- All MVPs in `.runs/iterate-cross-data.json` have funnel stage data (`reach`, `demand`, `activate`, `monetize`, `retain`)
- Migrated MVPs confirmed by Team Lead (if any)

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m['name'] for m in ms if not m.get('has_funnel_stage')]; assert not bad, 'MVPs missing funnel_stage: %s' % bad"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x2
```

**NEXT:** Read [state-x3-compute-scores.md](state-x3-compute-scores.md) to continue.
