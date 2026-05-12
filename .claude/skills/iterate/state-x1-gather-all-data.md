# STATE x1: GATHER_DATA

PostHog-only data gather. No Google Ads metrics (spend, CTR, QS, impressions).

**PRECONDITIONS:**
- MVP list confirmed (STATE x0 POSTCONDITIONS met)
- `.runs/iterate-cross-context.json` exists with `mvps` array, `posthog_project_id`, `window_days`

**ACTIONS:**

### Read context

```bash
POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key)
POSTHOG_PROJECT_ID=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-context.json'))['posthog_project_id'])")
WINDOW_DAYS=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-context.json'))['window_days'])")
```

### Build per-MVP event catalog query

For each MVP, query the top events with counts. Catalog feeds STATE x2 (signup classification) and STATE x3 (signup count using mvp_mappings).

The query uses **one round-trip** with UNION ALL of per-MVP subqueries. Build via Python to handle dynamic mvp list cleanly:

```bash
python3 - <<'PY'
import json
ctx = json.load(open('.runs/iterate-cross-context.json'))
mvps = ctx['mvps']
window_days = ctx['window_days']

parts = []
values = {"empty": ""}
for i, m in enumerate(mvps):
    # Skip orphan synthetic MVPs (no project_name → nothing to catalog by project_name).
    # They flow through x1a → MISSING_PROJECT_NAME verdict in x3 with empty catalog.
    if m.get('orphan'):
        continue
    pj = f"pj_{i}"
    values[pj] = m['name']

    # Filter SOLELY by properties.project_name. The previous OR-LIKE branch on
    # $current_url cross-polluted similarly-named MVPs (e.g. rubberduck vs
    # rubber-duck-api). project_name is now the canonical MVP identifier —
    # enforced at /bootstrap state-3 by validate_experiment_yaml.py.
    subq = (
        f"SELECT {{{pj}}} AS mvp_key, "
        f"event AS event_name, "
        f"max(toString(properties.funnel_stage)) AS sample_stage, "
        f"count(*) AS event_count, "
        f"count(DISTINCT distinct_id) AS unique_users, "
        f"count(DISTINCT IF(properties.$session_entry_gclid IS NOT NULL AND properties.$session_entry_gclid != {{empty}}, distinct_id, NULL)) AS gclid_users "
        f"FROM events "
        f"WHERE timestamp >= now() - INTERVAL {window_days} DAY "
        f"AND properties.project_name = {{{pj}}} "
        f"AND event NOT LIKE '$%' "
        f"GROUP BY event_name "
        f"HAVING gclid_users > 0 OR unique_users >= 5"
    )
    parts.append(subq)

query = " UNION ALL ".join(parts)
body = {"query": {"kind": "HogQLQuery", "query": query, "values": values}}
json.dump(body, open('.runs/_iterate-cross-catalog-query.json', 'w'))
PY

curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  --data @.runs/_iterate-cross-catalog-query.json > .runs/_iterate-cross-catalog-raw.json
```

If the API returns an error (e.g., query too large because of many MVPs), split into batches of ≤20 MVPs and concatenate.

### Aggregate per-MVP totals + event catalog

```bash
python3 - <<'PY'
import json

ctx = json.load(open('.runs/iterate-cross-context.json'))
raw = json.load(open('.runs/_iterate-cross-catalog-raw.json'))
if 'results' not in raw:
    raise SystemExit(f"PostHog error: {json.dumps(raw)[:400]}")

# Map mvp_key -> list of {event, users, gclid_users, stage, count}
catalog_by_mvp = {}
for row in raw['results']:
    mvp_key, event_name, stage, event_count, unique_users, gclid_users = row
    if mvp_key not in catalog_by_mvp:
        catalog_by_mvp[mvp_key] = []
    catalog_by_mvp[mvp_key].append({
        'event': event_name,
        'event_count': event_count,
        'unique_users': unique_users,
        'gclid_users': gclid_users,
        'sample_stage': stage if stage else None,
    })

# Build per-MVP records. IMPORTANT: gclid_visitors comes directly from x0's
# discovery query (count(DISTINCT distinct_id) WHERE gclid IS NOT NULL grouped
# by project). Do NOT recompute by summing per-event gclid_users — that
# double-counts users who fire multiple events and over-counts MVPs that emit
# multiple landing-event names (e.g., during a migration: visit_landing +
# landing_view both present).
mvp_records = []
for m in ctx['mvps']:
    name = m['name']
    catalog = sorted(catalog_by_mvp.get(name, []), key=lambda e: -e['gclid_users'])
    total_events = sum(e['event_count'] for e in catalog)
    mvp_records.append({
        'name': name,
        'owner': m.get('owner'),
        'gclid_visitors': m.get('gclid_visitors', 0),  # authoritative count from x0 discovery
        'total_events_count': total_events,
        'first_seen': m.get('first_seen'),
        'last_seen': m.get('last_seen'),
        'sample_utm_campaign': m.get('sample_utm_campaign'),
        'event_catalog': catalog[:30],   # top 30 events by gclid_users
    })

bash_payload = json.dumps({'mvps': mvp_records})
print(bash_payload)
PY
```

Capture the JSON output and write the data file via the standard helper:

```bash
PAYLOAD=$(python3 - <<'PY'
# (same script as above; print json.dumps result)
PY
)
bash .claude/scripts/lib/write-gate-artifact.sh \
  --path .runs/iterate-cross-data.json \
  --payload "$PAYLOAD" \
  --skill iterate

rm -f .runs/_iterate-cross-catalog-query.json .runs/_iterate-cross-catalog-raw.json
```

**POSTCONDITIONS:**
- Per-MVP `gclid_visitors` and `total_events_count` recorded
- Per-MVP `event_catalog` (≤30 events) recorded with stage hints
- `.runs/iterate-cross-data.json` exists with required schema

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x1`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; m=ms[0]; assert m.get('name') and 'gclid_visitors' in m and 'total_events_count' in m and 'event_catalog' in m, 'missing required fields on first MVP'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x1
```

**NEXT:** Read [state-x1a-validate-data-integrity.md](state-x1a-validate-data-integrity.md) to continue.
