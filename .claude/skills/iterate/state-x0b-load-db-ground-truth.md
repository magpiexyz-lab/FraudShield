# STATE x0b: LOAD_DB_GROUND_TRUTH

Pulls authoritative signup counts from each MVP's primary database
(Supabase OR Railway Postgres), so x3 can cross-check PostHog's paid-signup
count against the database's actual signups and flag tracking divergence.

PostHog answers "how many paid users engaged with the page".
The database answers "how many actually completed signup".
The two should roughly agree; when they don't, that's a tracking gap worth
surfacing — not a verdict bug. stylica-ai's 33 (PH, including `activate`) →
2 (PH, `signup_complete`) → 6 (Supabase) is the canonical example: the gap
between 2 and 6 was a PostHog instrumentation delay (event added 2026-04-30
but first signup landed 2026-04-13).

Two passes run in sequence:
1. **Supabase pass** (Steps 1-2) — primary. Uses Management API to list
   projects, fuzzy-match MVP names, query signup tables.
2. **Railway pass** (Step 3) — fallback for MVPs the Supabase pass left
   unmapped. Uses `railway list --json` to enumerate Postgres-bearing
   projects, links each in a tempdir to pull DATABASE_PUBLIC_URL, queries
   via psql. Never overwrites a Supabase-sourced db_signups.

Both passes are independently optional: if neither auth is present, every
MVP ends with `db_signups: null` and the report falls back to PostHog-only.

## Why this state exists

Three classes of MVP-side tracking issues that PostHog cannot self-diagnose:

1. **Late instrumentation** — `signup_complete` track call added weeks after
   product launched. PH count looks too low; Supabase total exposes the gap.
2. **Wrong event name in `signup_events`** — operator-locked event over-counts
   (`activate` firing on image generation). PH count looks too high relative
   to actual DB rows.
3. **Broken backend signup** — PH fires events but DB never writes the user.
   PH count looks normal; Supabase has zero. Fixes a class of "we're paying
   for ads but the funnel is silently broken" bugs.

State-x3 consumes `db_signups` to emit one of four sanity flags:
`ph_attribution_broken`, `ph_undercount`, `ph_overcount`, `late_instrumentation`.
State-x3 uses `db_signups_real` for verdict-source decisions; `db_signups`
remains the raw count for backward compatibility and operator audit.

**PRECONDITIONS:**
- STATE x0a POSTCONDITIONS met (`.runs/iterate-cross-context.json` exists with `ga_clicks` on every MVP)
- At least ONE of: `~/.supabase/access-token` (via `supabase login`) OR `railway whoami` returns logged-in (via `railway login`). Both absent = step still runs but every MVP ends `db_signups: null`.

**ACTIONS:**

### Step 0: Detect Supabase availability

The Supabase pass (Steps 1-2) is the primary DB source. The Railway pass
(Step 3) is the fallback. Both passes are independently optional — if neither
auth is present, every MVP ends with `db_signups: null` and verdicts fall
back to PostHog-only (same as before either integration existed).

```bash
SUPABASE_AVAILABLE=true
if [ ! -f ~/.supabase/access-token ]; then
  echo "WARN: ~/.supabase/access-token not found. Skipping Supabase pass." >&2
  echo "       Will still try Railway pass (Step 3) as fallback." >&2
  echo "       Run \`supabase login\` once to enable the Supabase cross-check." >&2
  # Pre-stamp all mvps with no_token so a subsequent Railway pass can refine.
  # Build the full updated context as a payload and re-write via the canonical
  # writer (agent-output-contract: never directly write to gate-readable paths).
  PAYLOAD=$(python3 -c "
import json
ctx = json.load(open('.runs/iterate-cross-context.json'))
for m in ctx['mvps']:
    m['db_signups'] = None
    m['db_unmapped_reason'] = 'no_token'
print(json.dumps(ctx))
")
  bash .claude/scripts/lib/write-gate-artifact.sh \
    --path .runs/iterate-cross-context.json \
    --payload "$PAYLOAD" \
    --skill iterate-cross
  SUPABASE_AVAILABLE=false
fi
```

### Step 1: Fuzzy-match MVPs to Supabase projects + operator confirm

Skipped entirely when `SUPABASE_AVAILABLE=false`. Run the whole `if`-block:

```bash
if [ "$SUPABASE_AVAILABLE" = "true" ]; then
  python3 .claude/scripts/lib/iterate_cross_db.py merge \
    --context .runs/iterate-cross-context.json \
    --config experiment/iterate-cross-config.yaml \
    --run-dir .runs > .runs/_iterate-cross-db-step1.json
  STEP1_EXIT=$?
fi
```

The script reads context, calls Supabase Management API to list all projects
accessible to the token, fuzzy-matches each MVP name against project names by
normalized-name (strip non-alphanumerics + lowercase) using three strategies:

1. Exact match (`stylica-ai` == `stylica-ai`)
2. Project name contains MVP name (`neuralpost` vs `neuralpost-prod`)
3. MVP name contains project name (rarer)

**Exit codes:**
- `0` (merged): every MVP either has `supabase_project_ref` in config, no
  fuzzy-match candidate (logged as unmapped), or was just auto-matched and
  the queries succeeded. Proceed.
- `2` (needs_confirm): one or more MVPs got an auto-match that's about to
  be persisted to config. Print the proposed mapping to the operator and
  re-run with `--auto-confirm` once they've eyeballed it.

```bash
if [ "$SUPABASE_AVAILABLE" = "true" ] && [ "$STEP1_EXIT" = "2" ]; then
  echo ""
  echo "═══ Proposed MVP → Supabase project mapping ═══" >&2
  python3 -c "
import json
d = json.load(open('.runs/_iterate-cross-db-step1.json'))
for m in d['needs_confirm']:
    alts = f'  [also: {len(m[\"alternatives\"])} other candidates]' if m.get('alternatives') else ''
    print(f\"  {m['mvp']:25s} → {m['project_ref']:25s}  {m['project_name']:25s}  ({m['match_type']}){alts}\")
print()
print(f'Unmapped (no Supabase project found): {d[\"unmatched\"]}')
" >&2
  echo "" >&2
  echo "Review the mapping above. If correct, re-run /iterate --cross." >&2
  echo "(The auto-match runs once per missing supabase_project_ref entry; subsequent runs read from config.)" >&2
  exit 1
fi
```

### Step 2: Persist mapping + query each project (run via merge --auto-confirm)

Re-invoke with auto-confirm to write the matched refs to config and execute
the queries:

```bash
if [ "$SUPABASE_AVAILABLE" = "true" ]; then
  python3 .claude/scripts/lib/iterate_cross_db.py merge \
    --context .runs/iterate-cross-context.json \
    --config experiment/iterate-cross-config.yaml \
    --run-dir .runs \
    --auto-confirm > .runs/_iterate-cross-db-step2.json

  python3 -c "
import json
d = json.load(open('.runs/_iterate-cross-db-step2.json'))
print(f'Supabase DB ground truth: queried={d[\"queried\"]} unmapped={d[\"unmapped\"]} errors={d[\"errors\"]}')
"
fi
```

The merge step writes per-MVP into `iterate-cross-context.json`:
- `supabase_project_ref` — the Supabase project ID
- `db_signups` — int count from the largest signup-shape table in window
- `db_signups_table` — which table won (e.g. `auth.users.confirmed`, `public.waitlist`)
- `db_first_signup_at` — ISO timestamp of earliest row in window (used by x3 for `late_instrumentation` flag)
- `db_breakdown` — per-table counts for transparency
- `db_unmapped_reason` — set to `"no_match"`, `"no_token"`, or `"orphan"` when `db_signups` is null

### Step 3: Railway fallback (sibling DB source)

For every MVP that the Supabase pass left as `db_signups: None` with
`db_unmapped_reason: "no_match"`, try Railway. This catches MVPs whose
primary DB lives on Railway-hosted Postgres instead of Supabase
(`Outcome-Oracle` pattern). The Supabase pass is preserved as authoritative —
Railway is a strict fallback and never overwrites a non-null `db_signups`.

```bash
# Same auto-confirm shape as Supabase step 2, but always one shot: Railway
# has far fewer Postgres projects than Supabase has projects, so ambiguity
# pressure is low. Bumping to a needs_confirm review path is future work.
python3 .claude/scripts/lib/iterate_cross_railway_db.py merge \
  --context .runs/iterate-cross-context.json \
  --config experiment/iterate-cross-config.yaml \
  --run-dir .runs \
  --auto-confirm > .runs/_iterate-cross-railway-step.json

python3 -c "
import json
d = json.load(open('.runs/_iterate-cross-railway-step.json'))
step = d.get('step')
if step == 'skipped_auth':
    print(f'Railway fallback skipped: {d.get(\"reason\")}')
    print('  (Run \`! railway login\` in the prompt box to enable Railway DB cross-check.)')
elif step == 'skipped_no_psql':
    print(f'Railway fallback skipped: {d.get(\"reason\")}')
    print('  (psql is the SQL client used to query Railway Postgres URLs.)')
elif step == 'no_candidates':
    print('Railway fallback: no Supabase-unmapped MVPs to retry.')
elif step == 'no_postgres_projects':
    print(f'Railway fallback: workspace has no Postgres-bearing projects ({d.get(\"unmapped\", 0)} MVPs stay unmapped).')
elif step == 'merged':
    print(f'Railway fallback: queried={d.get(\"queried\")} '
          f'still_unmapped={d.get(\"unmapped\")} errors={d.get(\"errors\")} '
          f'(of {d.get(\"total_candidates\")} candidates)')
"
```

Railway-side fields written into `iterate-cross-context.json` (additive to the
Supabase schema; do NOT overlap):

- `railway_project_id` — UUID of the Railway project (mirrors `supabase_project_ref`)
- `railway_project_name` — display name
- `railway_service_name` — which Postgres service won (e.g. `Postgres`, `Postgres-5HUP`)
- `db_source` — `"supabase"` or `"railway"` so x3/x4 can tell where the number came from
- `db_signups_table` — Railway-sourced tables are prefixed `railway:` (e.g. `railway:public.users`)
- `db_unmapped_reason` — refined from `"no_match"` → `"no_match_neither"` when neither source matched

**Railway-side preconditions:**
- `railway` CLI installed (`which railway`)
- Authenticated via `railway login` (token at `~/.railway/config.json`)
- `psql` available locally (queries use `DATABASE_PUBLIC_URL` proxy)

If any precondition fails, the step prints a notice and continues — Railway
is optional, just like Supabase token absence skips that pass.

### Step 4: Operator override hooks

When auto-discovery picks the wrong table OR you want to lock a fuzzy match
against future drift, the operator overrides in
`experiment/iterate-cross-config.yaml`:

```yaml
mvp_mappings:
  diarly:                                          # Supabase MVP
    supabase_project_ref: qiinzizrdjzlrhasddtw
    db_signup_table: public.waitlist_subscribers_only
  outcome-oracle:                                  # Railway MVP
    railway_project_id: 999fa04b-9c0b-47cd-af5e-5587c6bd9e49
    railway_service_name: Postgres                 # only needed when project has multiple PG services
    db_signup_table: public.users                  # same override field works for both sources
```

`db_signup_table` accepts `auth.<table>` (Supabase only; uses
`email_confirmed_at IS NOT NULL` filter) or `public.<table>` (uses the table's
discovered timestamp column for window filtering). Railway has no `auth.*`
schema so only `public.<table>` is valid there.

### Cleanup

```bash
rm -f .runs/_iterate-cross-db-step1.json .runs/_iterate-cross-db-step2.json .runs/_iterate-cross-railway-step.json
```

**POSTCONDITIONS:**
- Every MVP record has `db_signups`, `db_signups_raw`, `db_signups_real`, `db_signups_team`, `db_signups_test`, `db_signups_filter_audit`, `db_signups_real_windowed`
- Every MVP record has `db_unmapped_reason` when `db_signups_real` is null
  (`"no_match"` if only Supabase was tried, `"no_match_neither"` if Railway was also tried and failed,
  `"no_token"` / `"orphan"` for the existing reasons)
- MVPs that got auto-matched have `supabase_project_ref` OR `railway_project_id` written to config (idempotent)

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x0b`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-context.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; req=['db_signups','db_signups_raw','db_signups_real','db_signups_team','db_signups_test','db_signups_filter_audit','db_signups_real_windowed','db_first_signup_at','db_unmapped_reason']; bad=[m.get('name','?') for m in ms if any(k not in m for k in req)]; assert not bad, 'MVPs missing DB fields: %s' % bad; inv=[m.get('name','?') for m in ms if ((m.get('db_signups_real') is None) != (m.get('db_unmapped_reason') is not None))]; assert not inv, 'db_signups_real/db_unmapped_reason invariant failed: %s' % inv"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0b
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue.
