# STATE x0a: LOAD_GA_CSV

Operator-supplied CSV is the sole source of paid-click data. No browser scrape,
no silent-skip. If the CSV is missing, stale (>24h old), or malformed, this
state HALTS with explicit instructions and `/iterate --cross` cannot proceed.

## Why this state exists

PostHog `gclid_visitors` undercounts paid traffic by 20–65% (SDK ad-blocker, DNT,
fast-bounce before lazy-imported analytics fires) and is entirely blind to
deploys whose `src/lib/analytics.ts` isn't imported on the landed route —
those deploys cost spend but emit zero events.

Google Ads "Clicks" is the ground truth for "how many real paid visitors
landed." The operator exports a CSV; the skill folds it into the verdict
pipeline. State-x3 prefers `ga_clicks` over PostHog `gclid_visitors` as the
denominator when both are present.

A prior Chrome MCP browser scrape was removed because it was brittle to Google
Ads UI changes (column-position drift, render timing, anti-automation
fallback page) and failed silently — producing zero or junk `ga_clicks` values
that masqueraded as real data. CSV export is the only supported source.

**PRECONDITIONS:**
- STATE x0 POSTCONDITIONS met (`.runs/iterate-cross-context.json` exists with `mvps`)

**ACTIONS:**

### Step 0: Blocking CSV gate

Check `.runs/iterate-cross-ga-clicks.csv`: file must exist, be ≤24h old, and
have a valid header. If any check fails, HALT with the export instructions
below. State does not advance until the operator provides a fresh, valid CSV
and re-runs `/iterate --cross`.

The 24h freshness gate prevents silent reuse of stale paid-click data across
sessions (`.runs/` is gitignored and never auto-cleaned, so a CSV from days
ago would otherwise flow through unnoticed and produce verdicts that don't
match current ad spend).

```bash
CSV=.runs/iterate-cross-ga-clicks.csv
MAX_AGE_HOURS=24
WINDOW_DAYS=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-context.json')).get('window_days', 90))")

print_export_instructions() {
  cat >&2 <<EOF

How to export (~30 seconds):

  1. Open the MCC parent campaigns view (one of your saved Google Ads URLs):
     https://ads.google.com/aw/campaigns?ocid=<MCC>&authuser=2
  2. Set the date range to last ${WINDOW_DAYS} days
     (matches window_days in experiment/iterate-cross-config.yaml)
  3. Make sure the columns include at minimum: Campaign, Clicks
     (recommended: + Account, Conversions, Impr.)
  4. Click Download icon -> CSV
  5. Save the file as: .runs/iterate-cross-ga-clicks.csv (overwrite if present)
  6. Re-run /iterate --cross

The skill cannot produce trustworthy verdicts without fresh paid-click data.
PostHog visitor counts undercount paid traffic by 20-65% and are blind to
deploys with broken event tracking. CSV path makes verdicts reflect real
ad spend.
EOF
}

if [ ! -f "$CSV" ]; then
  echo "STOP: /iterate --cross requires a Google Ads click CSV." >&2
  print_export_instructions
  exit 1
fi

AGE_HOURS=$(python3 -c "import os, time; print(int((time.time() - os.path.getmtime('$CSV')) / 3600))")
if [ "$AGE_HOURS" -gt "$MAX_AGE_HOURS" ]; then
  echo "STOP: GA CSV is ${AGE_HOURS}h old (max ${MAX_AGE_HOURS}h)." >&2
  echo "File: $CSV" >&2
  echo "Stale paid-click data produces unreliable verdicts -- re-export from Google Ads." >&2
  print_export_instructions
  exit 1
fi

python3 .claude/scripts/lib/iterate_cross_ga.py validate-csv \
  --ga-csv "$CSV" \
  --context .runs/iterate-cross-context.json || exit 1
```

Column requirements (preamble-aware header detection; exact header matches win
before substring matches so `Campaign status` cannot shadow `Campaign`):
- **Required:** `Campaign`, `Clicks`
- **Optional but recommended:** `Account`, `Conversions` (or `Conv.`), `Impr.`

The parser is column-order agnostic (header-indexed), strips UTF-8 BOM, skips
summary footer rows (starting with `Total`), and strips thousands separators
(`1,082` → 1082). A header-only CSV is accepted with a soft warning (legitimate
case: the date window captured zero paid clicks).

### Step 1: Merge

```bash
python3 .claude/scripts/lib/iterate_cross_ga.py merge \
  --ga-csv "$CSV" \
  --context .runs/iterate-cross-context.json \
  --config experiment/iterate-cross-config.yaml \
  --unmatched-out .runs/_iterate-cross-ga-unmatched.json
```

The merge:
- Buckets each campaign to an MVP via substring match on stripped campaign name
  (xpredict → x-predict, brigent-search-v2 → brigent), honoring operator
  `ga_campaign_aliases` for names that don't substring-match (StaylicaAi-Lew
  → stylica-ai, PubCheck → verify).
- Auto-creates `ga_only: true` MVP records for campaigns with no PostHog
  presence (state-x1a's `ga_clicks_without_ph_traffic` flag picks these up;
  state-x3 emits `GA_NO_PH_TRACKING` verdict for them).
- Folds into orphan rows when the GA campaign name match_keys to an orphan
  host (e.g., `Hospitica-search-v2` → `__orphan_hospitica__`).
- Writes unmatched campaigns to `.runs/_iterate-cross-ga-unmatched.json`
  (placeholder names like `Campaign #1` land here — operator triages).
- Sets `ga_clicks=0` on every existing MVP record even when CSV is header-only,
  so the x0a VERIFY postcondition holds.
- Idempotent: re-running with the same CSV overwrites `ga_clicks` cleanly.

### Step 2: Review unmatched (operator triage hint)

If `.runs/_iterate-cross-ga-unmatched.json` is non-empty, the merge step has
already printed `WARN: unmatched GA campaign '<name>' (<N> clicks, reason=...)`
to stderr. For each unmatched campaign whose `reason` is `unmatched`, the
operator typically adds an entry to `ga_campaign_aliases` in
`experiment/iterate-cross-config.yaml` and re-runs `/iterate --cross`.
Campaigns with `reason=placeholder` (literal `Campaign #1` etc.) require the
operator to rename them in Google Ads first.

**POSTCONDITIONS:**
- Every MVP record in `.runs/iterate-cross-context.json` has `ga_clicks` field (≥0)
- New `ga_only: true` MVPs appended for GA campaigns lacking a PH match
- `.runs/_iterate-cross-ga-unmatched.json` exists (may be empty array)

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x0a`.

```bash
python3 -c "import json, os; d=json.load(open('.runs/iterate-cross-context.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m.get('name','?') for m in ms if 'ga_clicks' not in m]; assert not bad, 'MVPs missing ga_clicks (CSV merge sets ga_clicks=0 on every MVP even for header-only zero-click CSV): %s' % bad; assert os.path.isfile('.runs/_iterate-cross-ga-unmatched.json'), 'unmatched triage file missing (x0a postcondition)'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0a
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue.
