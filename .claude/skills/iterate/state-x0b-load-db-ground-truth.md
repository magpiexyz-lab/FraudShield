# STATE x0b: LOAD_DB_GROUND_TRUTH

Pulls authoritative signup counts from each MVP's Supabase database, so x3 can
cross-check PostHog's paid-signup count against the database's actual signups
and flag tracking divergence.

PostHog answers "how many paid users engaged with the page".
Supabase answers "how many actually completed signup".
The two should roughly agree; when they don't, that's a tracking gap worth
surfacing — not a verdict bug. stylica-ai's 33 (PH, including `activate`) →
2 (PH, `signup_complete`) → 6 (Supabase) is the canonical example: the gap
between 2 and 6 was a PostHog instrumentation delay (event added 2026-04-30
but first signup landed 2026-04-13).

This state is OPTIONAL: when the Supabase access token is absent, x0b skips
with a warning instead of halting. /iterate --cross still produces verdicts;
they're just one fewer column rich.

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

**PRECONDITIONS:**
- STATE x0a POSTCONDITIONS met (`.runs/iterate-cross-context.json` exists with `ga_clicks` on every MVP)
- `~/.supabase/access-token` exists (created by `supabase login` once per machine)

**ACTIONS:**

### Step 0: Optional gate — Supabase token present?

```bash
if [ ! -f ~/.supabase/access-token ]; then
  echo "WARN: ~/.supabase/access-token not found. Skipping DB ground-truth probe." >&2
  echo "       /iterate --cross will still produce verdicts but db_signups will be null." >&2
  echo "       Run \`supabase login\` once to enable the DB cross-check." >&2
  # Stamp all mvps with null db_signups so x1 schema check still passes.
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
  bash .claude/scripts/advance-state.sh iterate-cross x0b
  exit 0
fi
```

### Step 1: Fuzzy-match MVPs to Supabase projects + operator confirm

```bash
python3 .claude/scripts/lib/iterate_cross_db.py merge \
  --context .runs/iterate-cross-context.json \
  --config experiment/iterate-cross-config.yaml > .runs/_iterate-cross-db-step1.json
STEP1_EXIT=$?
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
if [ "$STEP1_EXIT" = "2" ]; then
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
python3 .claude/scripts/lib/iterate_cross_db.py merge \
  --context .runs/iterate-cross-context.json \
  --config experiment/iterate-cross-config.yaml \
  --auto-confirm > .runs/_iterate-cross-db-step2.json

python3 -c "
import json
d = json.load(open('.runs/_iterate-cross-db-step2.json'))
print(f'DB ground truth: queried={d[\"queried\"]} unmapped={d[\"unmapped\"]} errors={d[\"errors\"]}')
"
```

The merge step writes per-MVP into `iterate-cross-context.json`:
- `supabase_project_ref` — the Supabase project ID
- `db_signups` — int count from the largest signup-shape table in window
- `db_signups_table` — which table won (e.g. `auth.users.confirmed`, `public.waitlist`)
- `db_first_signup_at` — ISO timestamp of earliest row in window (used by x3 for `late_instrumentation` flag)
- `db_breakdown` — per-table counts for transparency
- `db_unmapped_reason` — set to `"no_match"`, `"no_token"`, or `"orphan"` when `db_signups` is null

### Step 3: Operator override hooks

When auto-discovery picks the wrong table, the operator overrides in
`experiment/iterate-cross-config.yaml`:

```yaml
mvp_mappings:
  diarly:
    supabase_project_ref: qiinzizrdjzlrhasddtw
    db_signup_table: public.waitlist_subscribers_only   # explicit override
```

`db_signup_table` accepts `auth.<table>` (only `auth.users` supported, uses
`email_confirmed_at IS NOT NULL` filter) or `public.<table>` (uses the table's
discovered timestamp column for window filtering).

### Cleanup

```bash
rm -f .runs/_iterate-cross-db-step1.json .runs/_iterate-cross-db-step2.json
```

**POSTCONDITIONS:**
- Every MVP record has `db_signups` field (int OR null)
- Every MVP record has `db_unmapped_reason` when `db_signups` is null
- MVPs that got auto-matched have `supabase_project_ref` written to config (idempotent)

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x0b`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-context.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m.get('name','?') for m in ms if 'db_signups' not in m]; assert not bad, 'MVPs missing db_signups (x0b should set null when unmapped, not omit): %s' % bad"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0b
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue.
