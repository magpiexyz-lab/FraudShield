# STATE x0: DISCOVER_MVPS

PostHog-based MVP discovery. No Google Ads / Chrome MCP dependency.

**PRECONDITIONS:**
- `~/.posthog/personal-api-key` exists and has scope `query:read` and `project:read`

**ACTIONS:**

### Read PostHog credentials

```bash
POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key 2>/dev/null)
```

If the file does not exist, STOP:
> "PostHog personal API key not found at `~/.posthog/personal-api-key`."
> "Create one at https://us.posthog.com/settings/user-api-keys (scope: Query Read, Project Read), then save it:"
> "```"
> "mkdir -p ~/.posthog && echo 'phx_YOUR_KEY' > ~/.posthog/personal-api-key"
> "```"
> "Then re-run `/iterate --cross`."

### Discover PostHog project ID

```bash
POSTHOG_PROJECT_ID=$(curl -s "https://us.i.posthog.com/api/projects/" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" | python3 -c "import sys,json; print(json.load(sys.stdin)['results'][0]['id'])")
```

If this fails (key lacks `project:read` scope, network error, etc.), report the error and STOP. If the team has multiple PostHog projects and the wrong one is auto-picked, the operator can override via `experiment/iterate-cross-config.yaml` `posthog_project_id`.

### Read operator config (with safe defaults)

Read `experiment/iterate-cross-config.yaml`. If missing, use inline defaults and emit a one-time notice:

```yaml
window_days: 90              # how far back to look
phase_filter:
  utm_campaign_like: ""      # empty = all gclid traffic; e.g. "%-search-v%" = Phase 1 Manual CPC convention
  fallback_all_gclid: true   # if utm_campaign_like has no matches for an MVP, count all gclid traffic
mvp_mappings: {}             # per-MVP overrides (signup_events, owner, deploy_domain)
thresholds:
  signups_go: 3
  visitors_floor: 50
```

If `posthog_project_id` is set in the config, use it instead of auto-discovery.

If `phase_filter.utm_campaign_like` is set, x0 surfaces both:
- "Phase 1 candidates": projects where utm_campaign matches the pattern
- "All-gclid candidates": projects with any gclid traffic (broader view)

### Discover MVPs from PostHog

Query distinct `project_name` values with gclid traffic in the time window. `project_name` is the canonical MVP identifier (set verbatim from `experiment.yaml.name` by `/bootstrap` STATE 3 — see `.claude/scripts/lib/validate_experiment_yaml.py`). Events without `project_name` are orphaned and surfaced separately for triage.

**gclid length filter (`length(...) > 30`)** — real Google Ads gclids are 60-120 char base64-url strings. Short sentinels like `test123` or 10-digit numbers come from operator manual debug traffic (see `.claude/patterns/iterate-cross-debug-prompts.md` NO_DATA step 6) and must be excluded from cross-MVP analytics. **Do not extend the test gclid length above 30 chars without updating this filter** — the convention is enforced consumer-side here, in `state-x1-gather-all-data.md`, in `state-x2-classify-signups.md`, and in `state-c2-auto-fix.md` (offline conversion import).

```bash
WINDOW_DAYS=$(python3 -c "
import yaml, os
cfg = {}
if os.path.exists('experiment/iterate-cross-config.yaml'):
    cfg = yaml.safe_load(open('experiment/iterate-cross-config.yaml')) or {}
print(cfg.get('window_days', 90))
")

cat > /tmp/iterate-cross-discover.json <<JSON
{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT properties.project_name AS mvp_key, max(properties.utm_campaign) AS sample_utm_campaign, count(DISTINCT distinct_id) AS gclid_visitors, min(timestamp) AS first_seen, max(timestamp) AS last_seen FROM events WHERE properties.\$session_entry_gclid IS NOT NULL AND properties.\$session_entry_gclid != {empty} AND length(toString(properties.\$session_entry_gclid)) > 30 AND properties.project_name IS NOT NULL AND properties.project_name != {empty} AND timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY GROUP BY mvp_key HAVING gclid_visitors > 0 ORDER BY gclid_visitors DESC LIMIT 200",
    "values": {"empty": ""}
  }
}
JSON

curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  --data @/tmp/iterate-cross-discover.json > .runs/_iterate-cross-discover.json
```

Parallel sibling query — count gclid events with NULL/empty `project_name`. These get surfaced in the operator confirmation message; they are NOT auto-keyed by URL anymore (the previous `splitByChar(domain($current_url))[1]` fallback created cross-pollution between similarly-named MVPs):

```bash
cat > /tmp/iterate-cross-orphan.json <<JSON
{
  "query": {
    "kind": "HogQLQuery",
    "query": "SELECT splitByChar('.', domain(coalesce(properties.\$current_url, '')))[1] AS host_prefix, count(DISTINCT distinct_id) AS gclid_visitors FROM events WHERE properties.\$session_entry_gclid IS NOT NULL AND properties.\$session_entry_gclid != {empty} AND length(toString(properties.\$session_entry_gclid)) > 30 AND (properties.project_name IS NULL OR properties.project_name = {empty}) AND timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY GROUP BY host_prefix HAVING gclid_visitors > 0 ORDER BY gclid_visitors DESC LIMIT 50",
    "values": {"empty": ""}
  }
}
JSON

curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $POSTHOG_API_KEY" \
  --data @/tmp/iterate-cross-orphan.json > .runs/_iterate-cross-orphan.json
```

Parse results into MVP records. Each MVP gets:
- `name` — `mvp_key` from query (always equals `properties.project_name` — never URL-derived)
- `gclid_visitors` — visitor count in window
- `first_seen`, `last_seen` — ISO timestamps
- `sample_utm_campaign` — one example utm_campaign value (informational)
- `owner` — read from `mvp_mappings.<name>.owner` if set, else null
- `deploy_domain` — from `mvp_mappings.<name>.deploy_domain` if set, else null (informational; no longer used for query filtering)
- `phase_match` — true if `sample_utm_campaign` matches `phase_filter.utm_campaign_like` (or `phase_filter.utm_campaign_like` is empty)
- `orphan` — always `false` for entries from this discovery query (orphan entries are handled separately, see next step)

Add one synthetic MVP record per orphan host:
- `name` — `__orphan_<host_prefix>__` (sentinel form; double-underscore prefix avoids collision with kebab-case MVP names)
- `gclid_visitors` — from orphan query
- `orphan` — `true`
- All other fields null

These orphan records propagate the `missing_project_name` flag through x1a → verdict pipeline so the operator can see which deploys are missing tracking.

### Merge aliases (legacy duplicate-key dedup)

Before applying the phase filter, merge MVPs that the operator has declared as aliases of each other. This handles MVPs created before /bootstrap state-3 enforced kebab-case (a `split-share-neon` deploy and a `splitshare` deploy reporting under two different `project_name` values for the same product).

```bash
python3 .claude/scripts/lib/iterate_cross_classify.py merge-aliases \
  --discovery .runs/_iterate-cross-discover.json \
  --config experiment/iterate-cross-config.yaml \
  --output .runs/_iterate-cross-discover.json
```

The script reads `mvp_aliases:` from the config, sums visitor counts into the canonical record, takes min/max of timestamps, and preserves the canonical's other fields. Aliases referenced in config but absent from PostHog discovery are silently ignored (config can lag the data). Conflicting aliases (one alias key listed under two canonicals) exit non-zero. The script is idempotent.

### Apply phase filter

If `phase_filter.utm_campaign_like` is set AND `phase_filter.fallback_all_gclid` is false: keep only MVPs with `phase_match: true`.
Else: keep all discovered MVPs.

### Confirm with operator

Present the discovered MVPs:
> "Found **N** MVPs with Google Ads gclid traffic in the last {window_days} days
> (M alias pairs merged via `mvp_aliases`, K orphan hosts have gclid events but no `project_name` — see warning below):
>
> | # | MVP | Owner | Visitors | Window | utm_campaign sample |
> |---|-----|-------|----------|--------|---------------------|
> | 1 | {name} | {owner or '—'} | {visitors} | {first_seen}→{last_seen} | {sample_utm_campaign or '(no utm)'} |
> | ... |
>
> ⚠ Orphan hosts (no `project_name` — fix tracking in those deploys):
> | Host prefix | Visitors |
> |-------------|----------|
> | {host_prefix} | {visitors} |
>
> Proceed with evaluation of all N MVPs?"

Wait for confirmation. If the operator wants to exclude/add MVPs, adjust the list. Orphan rows are surfaced for visibility but they do flow through to x1a → MISSING_PROJECT_NAME verdict (operator does not need to ack each one).

### Merge cross-specific fields into context

```bash
python3 -c "
import json

mvps = [
    # Populate from discovered + operator-confirmed list:
    # {'name': 'pettracker', 'owner': 'lee', 'gclid_visitors': 60,
    #  'first_seen': '2026-04-08T...', 'last_seen': '2026-05-06T...',
    #  'sample_utm_campaign': 'pettracker-search-v1',
    #  'deploy_domain': None, 'phase_match': True}
]

extra = {
    'mode': 'cross',
    'posthog_project_id': '$POSTHOG_PROJECT_ID',
    'window_days': $WINDOW_DAYS,
    'mvp_count': len(mvps),
    'mvps': mvps,
    'completed_states': ['x0']
}
json.dump(extra, open('.runs/_iterate-cross-extra.json', 'w'))
"
bash .claude/scripts/init-context.sh iterate-cross "@.runs/_iterate-cross-extra.json"
rm -f .runs/_iterate-cross-extra.json .runs/_iterate-cross-discover.json .runs/_iterate-cross-orphan.json /tmp/iterate-cross-discover.json /tmp/iterate-cross-orphan.json
```

The base fields (`skill`, `branch`, `timestamp`, `run_id`) are already set by lifecycle-init.sh.

**POSTCONDITIONS:**
- PostHog API key + project ID resolved
- MVPs discovered and operator-confirmed
- `.runs/iterate-cross-context.json` exists with `mvps` array — every MVP has `name`, `gclid_visitors`, `first_seen`, `last_seen`

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x0`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-context.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m.get('name','?') for m in ms if not m.get('name') or 'gclid_visitors' not in m]; assert not bad, 'MVPs missing required fields: %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue.
