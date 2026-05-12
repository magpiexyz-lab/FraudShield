# STATE x2: CLASSIFY_SIGNUPS

LLM-derived per-MVP signup event classification with **silent auto-accept** by default. Classifications are persisted to operator config and reused on subsequent runs.

This state does NOT prompt the operator for each MVP. The combination of (a) **code-enforced hard exclusion list** in `iterate_cross_classify.py` (cannot be bypassed by LLM error), (b) strong-prior LLM rules, (c) operator override lock via `classified_by: operator`, and (d) post-classification sanity check (suspect MVPs flagged when signups/visitors > 50%) covers the same safety surface that per-MVP confirmation would, without O(N) friction across many MVPs.

The heavy lifting (filtering, merging, sanity check, summary) runs in `.claude/scripts/lib/iterate_cross_classify.py` — unit-tested at `.claude/scripts/tests/test_iterate_cross_classify.py`. This state file is the orchestrator only.

**PRECONDITIONS:**
- STATE x1a POSTCONDITIONS met
- `.runs/iterate-cross-data.json` exists with `event_catalog` per MVP
- `.runs/iterate-cross-data-issues.json` exists with the five flags from x1a
- `.runs/iterate-cross-context.json` exists with `posthog_project_id`, `window_days`

**ACTIONS:**

### Step 1: Prepare classification buckets

```bash
python3 .claude/scripts/lib/iterate_cross_classify.py prepare \
  --data .runs/iterate-cross-data.json \
  --issues .runs/iterate-cross-data-issues.json \
  --config experiment/iterate-cross-config.yaml \
  --output .runs/_iterate-cross-classify-input.json
```

This writes three buckets:
- `to_skip`: MVPs whose operator already locked classification (`classified_by: operator`) or that already have a mapping in config — no work needed
- `to_auto`: MVPs whose catalog has events matching the operator's `signup_whitelist` — deterministically assigned (excluded events stripped automatically)
- `to_llm`: MVPs requiring LLM classification (no obvious whitelist match)

### Step 2: LLM classification (silent, inline)

Read `.runs/_iterate-cross-classify-input.json`. For each MVP in `to_llm`, inspect its `event_catalog` (top 20 events with `gclid_users` counts and `sample_stage` hint) and decide which event(s) represent **completed signup / committed conversion**.

#### Classification rules (priority order)

1. **Strong** (`confidence: 'strong'`): event names matching the canonical patterns — `signup_complete`, `signup_completed`, `register_complete`, `account_created`, `<role>_signup_complete` (e.g., `buyer_signup_complete`), `early_access_*`, `*_submitted` (when paired with form/email/waitlist semantics). Take all matches.

2. **Waitlist** (`confidence: 'strong'`): `waitlist_signup`, `waitlist_submit`, `waitlist_submitted`. Take all matches.

3. **Activation-as-signup** (`confidence: 'inferred'`): only when NO strong/waitlist match exists. Pick events whose name implies a meaningful first action consistent with the MVP's product type:
   - `api_key_create` for dev tools
   - `demo_completed` for demo-driven funnels
   - `first_check_completed`, `analysis_complete` for tool/calculator MVPs (NOT `model_recommended` — that's UI)
   - `location_connected` for connect-based MVPs
   - `<role>_registration_started` (e.g., `actor_registration_started`)
   Pick at most TWO events. Tag `confidence: 'inferred'`.

4. **Form submission** (`confidence: 'inferred'`): when catalog has `form_submitted` and no `signup_*` exists. Take it.

5. **Loose** (`confidence: 'loose'`): only as last resort, when only `signup_start` (no `_complete`) exists. Take it.

6. **Empty** (`confidence: 'empty'`): no event qualifies. Return `signup_events: []`. MVP will report INSUFFICIENT_DATA or NO_DATA in x3.

Do NOT manually filter excluded events — `iterate_cross_classify.py persist` will strip any UI/page events that slipped through. Your job is to make the best guess; the code is the safety net.

Write proposals to `.runs/_iterate-cross-classify-proposals.json` as a JSON array:

```json
[
  {"name": "diarly", "signup_events": ["signup_complete"], "confidence": "strong", "rationale": "Standard SaaS signup_complete (8 gclid users)."},
  {"name": "stylica-ai", "signup_events": ["signup_complete", "activate"], "confidence": "inferred", "rationale": "activate (32 gclid) is the real conversion signal — minimal signup_complete (2) suggests activate IS the conversion."}
]
```

### Step 3: Persist (filter + merge + write config)

```bash
python3 .claude/scripts/lib/iterate_cross_classify.py persist \
  --input .runs/_iterate-cross-classify-input.json \
  --proposals .runs/_iterate-cross-classify-proposals.json \
  --config experiment/iterate-cross-config.yaml \
  --summary .runs/_iterate-cross-classify-persist-summary.json
```

This script:
- Iterates `to_auto` + LLM proposals
- For each MVP: if existing mapping has `classified_by: operator` → **skip** (do not overwrite operator's manual choice)
- Otherwise: strip hard-excluded events from `signup_events` (using `EXCLUDED_PATTERNS`), merge into config under `mvp_mappings.<name>` with `classified_by: x2-<confidence>` and `classified_at: <ISO>`
- Preserves any existing `owner`, `deploy_domain`, `rationale` fields on the mapping
- Writes audit summary (which MVPs were preserved, which had events stripped)

### Step 4: Query signups using classified events

Build a UNION ALL query that counts gclid-filtered distinct signups per MVP using each MVP's now-persisted `signup_events`:

```bash
python3 - <<'PY'
import json, yaml, os

config = yaml.safe_load(open('experiment/iterate-cross-config.yaml')) or {}
mappings = config.get('mvp_mappings') or {}

data = json.load(open('.runs/iterate-cross-data.json'))
ctx = json.load(open('.runs/iterate-cross-context.json'))
window_days = ctx['window_days']

parts = []
values = {"empty": ""}
for i, mvp in enumerate(data['mvps']):
    # Orphan MVPs (no project_name) cannot be queried by project_name. They
    # default to 0 signups and flow through x3 as MISSING_PROJECT_NAME.
    if mvp.get('orphan'):
        continue
    mapping = mappings.get(mvp['name']) or {}
    signup_events = mapping.get('signup_events') or []
    if not signup_events:
        continue
    pj = f"pj_{i}"
    values[pj] = mvp['name']

    sg_conds = []
    for j, sg in enumerate(signup_events):
        k = f"sg_{i}_{j}"
        values[k] = sg
        sg_conds.append(f"event = {{{k}}}")
    sg_expr = "(" + " OR ".join(sg_conds) + ")"

    # Filter SOLELY by properties.project_name (canonical MVP identifier
    # enforced at /bootstrap state-3). The previous OR-LIKE branch on
    # $current_url double-counted signups across similarly-named MVPs.
    parts.append(
        f"SELECT {{{pj}}} AS mvp_key, "
        f"count(DISTINCT IF({sg_expr}, distinct_id, NULL)) AS signups "
        f"FROM events "
        f"WHERE properties.$session_entry_gclid IS NOT NULL AND properties.$session_entry_gclid != {{empty}} "
        f"AND timestamp >= now() - INTERVAL {window_days} DAY "
        f"AND properties.project_name = {{{pj}}}"
    )

if parts:
    body = {"query": {"kind": "HogQLQuery", "query": " UNION ALL ".join(parts), "values": values}}
    json.dump(body, open('.runs/_iterate-cross-signups-query.json', 'w'))
PY

if [ -f .runs/_iterate-cross-signups-query.json ]; then
  POSTHOG_API_KEY=$(cat ~/.posthog/personal-api-key)
  POSTHOG_PROJECT_ID=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-context.json'))['posthog_project_id'])")
  curl -s -X POST "https://us.i.posthog.com/api/projects/$POSTHOG_PROJECT_ID/query/" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $POSTHOG_API_KEY" \
    --data @.runs/_iterate-cross-signups-query.json > .runs/_iterate-cross-signups-out.json
else
  echo '{"results": []}' > .runs/_iterate-cross-signups-out.json
fi
```

### Step 5: Finalize (update data.json + sanity check + summary)

```bash
python3 .claude/scripts/lib/iterate_cross_classify.py finalize \
  --data .runs/iterate-cross-data.json \
  --config experiment/iterate-cross-config.yaml \
  --signup-counts .runs/_iterate-cross-signups-out.json \
  --persist-summary .runs/_iterate-cross-classify-persist-summary.json
```

This script:
- Merges `signup_events` from config into `.runs/iterate-cross-data.json`
- Applies signup counts from PostHog query (`.runs/_iterate-cross-signups-out.json`)
- Runs sanity check: any MVP with `gclid_visitors >= 10` AND `signups/gclid_visitors > 0.5` is flagged as **suspect** (a 50%+ conversion rate on cold ad traffic almost always means we picked a UI event by mistake)
- Prints classification summary + suspect warnings + inferred-classification review list to stdout
- Returns 0 (warn-only). Pass `--strict-sanity` to exit 1 on any suspect (for CI / safety-critical contexts).

### Cleanup

```bash
rm -f .runs/_iterate-cross-classify-input.json \
      .runs/_iterate-cross-classify-proposals.json \
      .runs/_iterate-cross-classify-persist-summary.json \
      .runs/_iterate-cross-signups-query.json \
      .runs/_iterate-cross-signups-out.json
```

**POSTCONDITIONS:**
- Every MVP has `signup_events` field (array, possibly empty) in `.runs/iterate-cross-data.json`
- Every MVP has `signups` field (integer ≥ 0) in `.runs/iterate-cross-data.json`
- Summary printed to stdout (classification counts + suspect MVPs + filter audit)
- Side effect (out-of-band, no VERIFY check): operator config file is updated with `mvp_mappings.<name>.signup_events`, `classified_by`, and `classified_at` for every newly-classified MVP. Operator overrides (`classified_by: operator`) are preserved. The data file's `signup_events` is sourced from the persisted config, so the data-file VERIFY transitively confirms the config write. <!-- enforced by agent behavior, not VERIFY gate -->

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
