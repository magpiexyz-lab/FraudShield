# STATE x2: CLASSIFY_SIGNUPS

LLM-derived per-MVP signup event classification with **silent auto-accept** by default. Classifications are persisted to `experiment/iterate-cross-config.yaml mvp_mappings` and reused on subsequent runs.

This state does NOT prompt the operator for each MVP. The combination of (a) hard exclusion list, (b) strong-prior LLM rules, (c) post-classification sanity check, and (d) operator-editable cache covers the same safety surface that a per-MVP confirmation would, without O(N) friction across many MVPs.

**PRECONDITIONS:**
- STATE x1a POSTCONDITIONS met
- `.runs/iterate-cross-data.json` exists with `event_catalog` per MVP
- `.runs/iterate-cross-data-issues.json` exists with `signup_classified`, `auto_default_match`, `needs_llm_classification` flags

**ACTIONS:**

### Read inputs + bucket MVPs

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

to_skip = []         # already classified, no work
to_auto = []         # auto-default match, derive deterministically
to_llm  = []         # needs LLM proposal

for mvp in data['mvps']:
    name = mvp['name']
    flags = issues_by_name[name]
    if flags['signup_classified']:
        to_skip.append(name)
    elif flags['no_event_data']:
        to_auto.append({'name': name, 'signup_events': [], 'confidence': 'empty', 'rationale': 'No events in catalog'})
    elif flags['auto_default_match']:
        cat_events = {e['event'] for e in mvp.get('event_catalog', [])}
        chosen = [e for e in default_whitelist if e in cat_events]
        to_auto.append({'name': name, 'signup_events': chosen, 'confidence': 'whitelist', 'rationale': f'Standard event(s): {", ".join(chosen)}'})
    elif flags['needs_llm_classification']:
        to_llm.append(mvp)

json.dump({
    'to_skip': to_skip,
    'to_auto': to_auto,
    'to_llm': [{'name': m['name'], 'event_catalog': m.get('event_catalog', [])[:20]} for m in to_llm],
}, open('.runs/_iterate-cross-classify-input.json', 'w'))
PY
```

### LLM classification (Claude does this inline, silent)

Read `.runs/_iterate-cross-classify-input.json`. For each MVP in `to_llm`, inspect the `event_catalog`. Classify silently — do NOT prompt the operator per MVP.

#### Hard exclusion list (NEVER classify as signup)

Reject these patterns even if `funnel_stage` is mistagged as `demand` or `activate`:

- `cta_click`, `cta_clicked`, `cta_*` — clicks, not conversions
- `landing_*`, `lander_*` — page-view events
- `*_view`, `*_viewed`, `*_visit` — UI/page events
- `scroll_*`, `scroll_depth`
- `attribution_captured`, `ad_clicked`
- `pricing_view`, `feed_view`, `feed_viewed`
- `$pageview`, `$autocapture`, `$pageleave`, `$*` — PostHog auto-capture
- `page_viewed`, `marketplace_view`, `marketplace_viewed`

If a catalog has ONLY excluded events with no signup-class event, return `signup_events: []`, `confidence: 'empty'`, `rationale: 'Catalog has only UI/page events'`.

#### Classification rules (in priority order)

1. **Strong (confidence: `strong`)**: any event name matching `signup_complete`, `signup_completed`, `register_complete`, `account_created`, `<role>_signup_complete` (e.g., `buyer_signup_complete`), `*_submitted` paired with `_email`/`_form`/`_waitlist`, `early_access_*`. Take all matches.

2. **Waitlist (confidence: `strong`)**: `waitlist_signup`, `waitlist_submit`, `waitlist_submitted`. Take all matches.

3. **Activation as signup (confidence: `inferred`)**: only when NO strong/waitlist match exists. Events where the name implies a meaningful first action AND the catalog suggests the MVP's core mechanic is that action:
   - `api_key_create` for dev tools
   - `demo_completed` for demo-driven funnels
   - `first_check_completed`, `analysis_complete`, `model_recommended` for tool/calculator MVPs
   - `location_connected` for connect-based MVPs
   - `<role>_registration_started` (e.g., `actor_registration_started`)
   Pick at most TWO events. Tag `confidence: 'inferred'`.

4. **Form submission (confidence: `inferred`)**: when catalog has `form_submitted` without `signup_*` → take it.

5. **Loose (confidence: `loose`)**: only as last resort, when no `_complete` event exists but catalog has `signup_start`. Take it. (Operator will see `loose` confidence in summary and can override in config.)

6. **Empty (confidence: `empty`)**: no event qualifies. Return `signup_events: []`. MVP will report INSUFFICIENT_DATA or NO_DATA in x3.

For each MVP, write a proposal:

```json
{"name": "diarly", "signup_events": ["signup_complete"], "confidence": "strong", "rationale": "Standard SaaS signup_complete (8 gclid users)."}
```

Write all proposals to `.runs/_iterate-cross-classify-proposals.json`.

### Persist to config (silent)

For each MVP in `to_auto` + `to_llm` proposals, merge into `experiment/iterate-cross-config.yaml` under `mvp_mappings.<name>`:

```yaml
mvp_mappings:
  diarly:
    signup_events: [signup_complete]
    classified_by: llm-x2-strong       # or llm-x2-inferred / llm-x2-loose / x2-whitelist / x2-empty
    classified_at: 2026-05-11T00:00:00Z
```

Preserve any existing fields under `mvp_mappings.<name>` (e.g., `owner`, `deploy_domain`, or operator-overridden `signup_events` — operator edits ALWAYS win; check if `classified_by == 'operator'` and skip if so).

### Query signups using classified events

After persistence, run one combined PostHog query (UNION ALL of per-MVP subqueries) to count signups per MVP using each MVP's classified events. Write counts back into `.runs/iterate-cross-data.json`:

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

for mvp in data['mvps']:
    mvp['signup_events'] = (mappings.get(mvp['name']) or {}).get('signup_events') or []

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
```

### Sanity check (catch misclassifications)

For each MVP, compute `signups_ratio = signups / max(gclid_visitors, 1)`. If `ratio > 0.5` AND `gclid_visitors >= 10` → flag as **suspect** and warn in the summary. A 50%+ conversion rate is implausibly high for cold ad traffic; almost always means we picked a UI-side event as "signup". Operator should review the affected MVP's `signup_events` in config and re-run.

```bash
python3 - <<'PY'
import json

data = json.load(open('.runs/iterate-cross-data.json'))
suspects = []
for mvp in data['mvps']:
    v = mvp.get('gclid_visitors', 0)
    s = mvp.get('signups', 0)
    if v >= 10 and s / v > 0.5:
        suspects.append({'name': mvp['name'], 'visitors': v, 'signups': s, 'ratio': round(s/v, 2), 'signup_events': mvp.get('signup_events', [])})

json.dump({'suspects': suspects}, open('.runs/_iterate-cross-classify-suspects.json', 'w'))
PY
```

### Print summary table

Print to stdout:

```
Classification summary ({N} MVPs):
  • {S} skipped (operator-confirmed via config)
  • {W} auto-classified via whitelist (standard event names)
  • {LS} LLM-classified, strong confidence
  • {LI} LLM-classified, inferred (heuristic)
  • {LL} LLM-classified, loose (no _complete event found)
  • {LE} empty classification (catalog has no signup-class event)

⚠ Suspect (signups/visitors > 50%; likely misclassification):
  • <mvp_name>: <visitors>v / <signups>sg (ratio <r>) — signup_events: [<events>]

Top LLM-inferred classifications (review-recommended):
  • <mvp_name> → <events> — <rationale>

Cached mappings live in experiment/iterate-cross-config.yaml. To override, edit the file
and re-run /iterate --cross.
```

If `--interactive` flag is set on the parent skill (future option), this state would instead present each proposal and wait. Default is silent.

```bash
rm -f .runs/_iterate-cross-classify-input.json .runs/_iterate-cross-classify-proposals.json .runs/_iterate-cross-signups-query.json .runs/_iterate-cross-signups-out.json
```

**POSTCONDITIONS:**
- Every MVP has `signup_events` field (array, possibly empty) in `.runs/iterate-cross-data.json`
- Every MVP has `signups` field (integer ≥ 0) in `.runs/iterate-cross-data.json`
- Summary table printed to stdout, listing classification counts + suspect MVPs (if any)
- Side effect (out-of-band, no VERIFY check): the operator config file is updated with `mvp_mappings.<name>.signup_events`, `classified_by`, and `classified_at` audit fields for every newly-classified MVP. Operator overrides (`classified_by: operator`) are never touched. The data file's `signup_events` is sourced from the persisted config, so the data-file VERIFY transitively confirms the config write. <!-- enforced by agent behavior, not VERIFY gate -->

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
