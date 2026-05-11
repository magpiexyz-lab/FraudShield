# STATE x2: CLASSIFY_SIGNUPS

LLM-derived per-MVP signup event classification. Replaces the deprecated event-funnel migration. Classifications are persisted to `experiment/iterate-cross-config.yaml mvp_mappings` and reused on subsequent runs.

**PRECONDITIONS:**
- STATE x1a POSTCONDITIONS met
- `.runs/iterate-cross-data.json` exists with `event_catalog` per MVP
- `.runs/iterate-cross-data-issues.json` exists with `signup_classified`, `auto_default_match`, `needs_llm_classification` flags

**ACTIONS:**

### Read inputs

```bash
python3 - <<'PY'
import json, os
import yaml

data = json.load(open('.runs/iterate-cross-data.json'))
issues = json.load(open('.runs/iterate-cross-data-issues.json'))
issues_by_name = {m['name']: m for m in issues['mvps']}

config_path = 'experiment/iterate-cross-config.yaml'
config = yaml.safe_load(open(config_path)) if os.path.exists(config_path) else {}
config = config or {}
mvp_mappings = config.get('mvp_mappings') or {}
default_whitelist = config.get('signup_whitelist') or [
    'signup_complete', 'waitlist_signup', 'waitlist_submit',
    'early_access_signup', 'activate', 'form_submitted'
]

# Buckets for downstream processing
to_skip = []         # already classified, no work
to_auto = []         # auto-default match, derive deterministically
to_llm  = []         # needs LLM proposal

for mvp in data['mvps']:
    name = mvp['name']
    flags = issues_by_name[name]
    if flags['signup_classified']:
        to_skip.append(name)
    elif flags['no_event_data']:
        # Unclassifiable; record empty proposal
        to_auto.append({'name': name, 'signup_events': []})
    elif flags['auto_default_match']:
        # Use intersection of default whitelist with catalog events
        cat_events = {e['event'] for e in mvp.get('event_catalog', [])}
        chosen = [e for e in default_whitelist if e in cat_events]
        to_auto.append({'name': name, 'signup_events': chosen})
    elif flags['needs_llm_classification']:
        to_llm.append(mvp)

json.dump({
    'to_skip': to_skip,
    'to_auto': to_auto,
    'to_llm': [{'name': m['name'], 'event_catalog': m.get('event_catalog', [])[:20]} for m in to_llm],
    'default_whitelist': default_whitelist,
}, open('.runs/_iterate-cross-classify-input.json', 'w'))
PY
```

### LLM classification step (Claude does this inline)

Read `.runs/_iterate-cross-classify-input.json`. For each MVP in `to_llm`, inspect the `event_catalog` (top events with counts and `sample_stage`).

Classify which events represent **completed signup / committed conversion** for that MVP. Apply these rules in order:

1. **Strong signals**: any event named `signup_complete`, `signup_completed`, `waitlist_signup`, `waitlist_submit`, `early_access_signup`, `early_access_submitted`, `email_submitted`, `register_complete`, `account_created`, `form_submitted`, `<role>_signup_complete` (e.g., `buyer_signup_complete`), `<role>_registration_started` — include directly.

2. **Activation events** (only when no strong signal exists): events where `sample_stage == 'activate'` and the name implies meaningful action — `api_key_create`, `analysis_complete`, `demo_completed`, `first_check_completed`, `location_connected`, `<feature>_completed`. Include only if no `signup_*` event exists in the catalog.

3. **Loose match** (last resort, when only intent events exist): events like `signup_start`, `cta_clicked` paired with `funnel_stage == 'demand'` AND no `_complete` event in catalog. Mark with `confidence: 'loose'` so the operator can review.

4. **Always exclude**: `cta_click`, `landing_*`, `*_view`, `*_viewed`, `scroll_depth`, `attribution_captured`, `pricing_view`, `feed_view` — these are UI/page events, never signups even if mistagged with `funnel_stage`.

5. **Domain heuristics**:
   - Marketplace MVPs (events with `marketplace_*`, `buyer_*`, `seller_*`) — pick the role-specific completion event.
   - Lead-gen / outbound MVPs (events with `outreach_*`, `discovery_call_*`) — pick the booking/submit event.
   - Calculator/tool MVPs — `analysis_complete`, `model_recommended`, `simulation_complete` count as activation if no signup exists.

6. **Empty proposal allowed**: if no event qualifies, return `signup_events: []` and `notes: "No signup-class event in catalog"`. The MVP will be reported as INSUFFICIENT_DATA in x3.

For each MVP, output a proposal:

```json
{
  "name": "diarly",
  "signup_events": ["signup_complete"],
  "rationale": "Standard SaaS signup_complete (8 gclid users). signup_start present but used as start-of-flow; signup_complete is the conversion."
}
```

Write all proposals to `.runs/_iterate-cross-classify-proposals.json`.

### Operator confirmation (batch)

Present proposals to the operator:

> **LLM-derived signup classifications** ({N} new MVPs need confirmation):
>
> | MVP | Proposed signup events | Rationale |
> |-----|------------------------|-----------|
> | diarly | `signup_complete` | Standard SaaS signup_complete (8 gclid users). |
> | smelt | `waitlist_signup`, `signup_complete` | Mixed waitlist + standard. |
> | stylica-ai | `signup_complete`, `activate` | activate (32 gclid) is the real conversion signal. |
> | mosai | _(none)_ | No signup-class event in catalog — INSUFFICIENT_DATA verdict. |
>
> Reply with one of:
> - **accept-all** — accept all proposals and persist
> - **edit** — interactive review per MVP
> - **abort** — exit without writing config

Wait for operator response. If `edit`, walk through each MVP one at a time; allow override of `signup_events`. If `accept-all`, proceed.

### Persist to config

For each MVP in `to_auto` + accepted-or-edited `to_llm`, merge into `experiment/iterate-cross-config.yaml`:

```yaml
mvp_mappings:
  diarly:
    signup_events: [signup_complete]
    classified_by: llm-x2
    classified_at: 2026-05-11T00:00:00Z
  smelt:
    signup_events: [waitlist_signup, signup_complete]
    classified_by: llm-x2
    classified_at: 2026-05-11T00:00:00Z
  mosai:
    signup_events: []
    classified_by: x2-empty
    classified_at: 2026-05-11T00:00:00Z
```

Preserve any existing fields under `mvp_mappings.<name>` (e.g., `owner`, `deploy_domain`).

### Update data file + query signups using classified events

Merge classifications into `.runs/iterate-cross-data.json`, then run ONE combined PostHog query to count signups per MVP using each MVP's classified events:

```bash
python3 - <<'PY'
import json, os, yaml

data = json.load(open('.runs/iterate-cross-data.json'))
config = yaml.safe_load(open('experiment/iterate-cross-config.yaml')) or {}
mappings = config.get('mvp_mappings') or {}

ctx = json.load(open('.runs/iterate-cross-context.json'))
window_days = ctx['window_days']

for mvp in data['mvps']:
    mvp['signup_events'] = (mappings.get(mvp['name']) or {}).get('signup_events') or []

# Build UNION ALL query: per-MVP signup count
parts = []
values = {"empty": ""}
for i, mvp in enumerate(data['mvps']):
    if not mvp['signup_events']:
        continue
    pj = f"pj_{i}"
    url = f"url_{i}"
    values[pj] = mvp['name']
    values[url] = f"%{(mappings.get(mvp['name']) or {}).get('deploy_domain') or mvp['name']}%"

    sg_conds = []
    for j, sg in enumerate(mvp['signup_events']):
        k = f"sg_{i}_{j}"
        values[k] = sg
        sg_conds.append(f"event = {{{k}}}")
    sg_expr = "(" + " OR ".join(sg_conds) + ")"

    subq = (
        f"SELECT {{{pj}}} AS mvp_key, "
        f"count(DISTINCT IF({sg_expr}, distinct_id, NULL)) AS signups "
        f"FROM events "
        f"WHERE properties.$session_entry_gclid IS NOT NULL AND properties.$session_entry_gclid != {{empty}} "
        f"AND timestamp >= now() - INTERVAL {window_days} DAY "
        f"AND (properties.project_name = {{{pj}}} OR properties.$current_url LIKE {{{url}}})"
    )
    parts.append(subq)

if parts:
    query = " UNION ALL ".join(parts)
    body = {"query": {"kind": "HogQLQuery", "query": query, "values": values}}
    json.dump(body, open('.runs/_iterate-cross-signups-query.json', 'w'))
PY

if [ -f .runs/_iterate-cross-signups-query.json ]; then
  POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key)
  POSTHOG_PROJECT_ID=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-context.json'))['posthog_project_id'])")
  curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $POSTHOG_API_KEY" \
    --data @.runs/_iterate-cross-signups-query.json > .runs/_iterate-cross-signups-out.json
fi

PAYLOAD=$(python3 - <<'PY'
import json, os, yaml

data = json.load(open('.runs/iterate-cross-data.json'))
config = yaml.safe_load(open('experiment/iterate-cross-config.yaml')) or {}
mappings = config.get('mvp_mappings') or {}

# Merge classifications (signup_events) from config
for mvp in data['mvps']:
    mvp['signup_events'] = (mappings.get(mvp['name']) or {}).get('signup_events') or []

# Apply signup counts from query result
counts = {}
if os.path.exists('.runs/_iterate-cross-signups-out.json'):
    out = json.load(open('.runs/_iterate-cross-signups-out.json'))
    for row in out.get('results', []):
        mvp_key, signups = row
        counts[mvp_key] = signups

for mvp in data['mvps']:
    mvp['signups'] = counts.get(mvp['name'], 0)

print(json.dumps(data))
PY
)

bash .claude/scripts/lib/write-gate-artifact.sh \
  --path .runs/iterate-cross-data.json \
  --payload "$PAYLOAD" \
  --skill iterate

rm -f .runs/_iterate-cross-classify-input.json .runs/_iterate-cross-classify-proposals.json .runs/_iterate-cross-signups-query.json .runs/_iterate-cross-signups-out.json
```

**POSTCONDITIONS:**
- Every MVP has `signup_events` field (array, possibly empty) in `.runs/iterate-cross-data.json`
- Every MVP has `signups` field (integer ≥ 0) in `.runs/iterate-cross-data.json`
- Side effect (verified by re-reading data): operator config `experiment/iterate-cross-config.yaml mvp_mappings.<name>.signup_events` is populated for every newly-classified MVP. The data file's `signup_events` is sourced from this config, so the data-file VERIFY transitively confirms the config write.
- Operator confirmed batch of LLM proposals (or accepted defaults)

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x2`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-data.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m['name'] for m in ms if 'signup_events' not in m or 'signups' not in m]; assert not bad, 'MVPs missing signup_events/signups: %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x2
```

**NEXT:** Read [state-x3-compute-scores.md](state-x3-compute-scores.md) to continue.
