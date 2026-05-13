# STATE x0a: SCRAPE_GA_CLICKS

Optional sub-state between x0 and x1. Folds Google Ads click data into the per-MVP
records produced by state-x0 so downstream verdicts (x3) and tables (x4) can use
GA clicks as the visitor denominator instead of PostHog `gclid_visitors`.

**Why this state exists:**
PostHog `gclid_visitors` systematically undercounts paid traffic — about 40-65% of
real ad clicks never trigger any PostHog event (SDK load failures from ad-blockers /
DNT / fast-bounce while `posthog-js` lazy-import is in flight, plus deep-link
landing pages where `analytics.ts` isn't imported). GA "Clicks" is the ground
truth for "how many real paid visitors landed". PostHog signups remain the
conversion ground truth — only the denominator changes.

This state is **silent-skippable**: if Chrome MCP tools aren't loaded and no CSV
fallback exists, state advances with `ga_clicks=0` on every MVP and x3 falls back
to the existing PostHog-only behavior.

**PRECONDITIONS:**
- STATE x0 POSTCONDITIONS met (`.runs/iterate-cross-context.json` with `mvps` array)

**ACTIONS:**

### Step 1: Detect data source (auto)

Check inputs in this order:
1. If `.runs/iterate-cross-ga-clicks.csv` exists → use CSV (operator-provided fallback). Skip Step 2.
2. Else if Chrome MCP tools are loaded (check via `ToolSearch query="select:mcp__claude-in-chrome__tabs_context_mcp"`) → use live scrape (Step 2).
3. Else → write `{"campaigns": []}` to `.runs/_iterate-cross-ga-raw.json` and continue to Step 3 (silent-skip path: still merges so `ga_clicks=0` lands on every MVP — POSTCONDITION still met).

The state ALWAYS runs Step 3 (merge), even on the silent-skip path. This guarantees every MVP record has a `ga_clicks` field, which downstream verdict / table consumers rely on. The state is genuinely optional — but the **field**, not the **state**, is what stays optional in the data shape.

```bash
# Silent-skip placeholder write (when no CSV and no Chrome MCP).
if [ ! -f .runs/iterate-cross-ga-clicks.csv ]; then
  if ! python3 -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('claude_mcp') else 1)" 2>/dev/null; then
    # Lead agent should ALSO confirm via ToolSearch; this bash check is a belt-and-suspenders write so the merge subcommand always has *something* to read.
    if [ ! -f .runs/_iterate-cross-ga-raw.json ]; then
      echo '{"campaigns": []}' > .runs/_iterate-cross-ga-raw.json
    fi
  fi
fi
```

The lead agent makes the real decision (Chrome MCP available or not) — the bash above only writes a fallback empty file when Chrome MCP appears unavailable from the bash environment, so `merge` never errors on missing input.

### Step 2: Scrape Google Ads (Chrome MCP path)

When Chrome MCP is available, the lead agent drives the scrape inline. The path is
specific to the MCC parent account so all 30+ sub-accounts are visible at once.

1. **Resolve tab.** Call `mcp__claude-in-chrome__tabs_context_mcp`. If a tab on
   `ads.google.com/aw/campaigns` exists with `workspaceId=-638109893` (MCC), reuse
   it; else create one via `mcp__claude-in-chrome__tabs_create_mcp` and navigate.

2. **Set time window + sort.** Open the date picker and select a range that
   covers `context.window_days` (default 90). Click the **Clicks** column header
   twice so the table sorts descending by clicks (the highest-spend campaigns
   appear first, useful for sanity check).

3. **Scrape via JavaScript.** Use `mcp__claude-in-chrome__javascript_tool` to run:

   ```js
   const rows = Array.from(document.querySelectorAll('div[role="row"]'));
   const campaigns = [];
   for (const r of rows) {
     const text = r.innerText.replace(/\n+/g, '|');
     const parts = text.split('|').map(s => s.trim()).filter(Boolean);
     if (parts.length === 0 || parts[0] === 'Campaign' || parts[0].startsWith('Total:') || parts[0] === 'expand_more') continue;
     if (parts[1] !== 'settings') continue;
     const typeIdx = parts.findIndex(p => p === 'Search' || p === 'Performance Max' || p === 'Display' || p === 'Shopping');
     if (typeIdx < 0) continue;
     const account = parts[typeIdx - 2] || '?';
     const impr = parseInt((parts[typeIdx + 1] || '0').replace(/,/g, '')) || 0;
     const clicks = parseInt((parts[typeIdx + 8] || '0').replace(/,/g, '')) || 0;
     const conv = parseFloat((parts[typeIdx + 10] || '0').replace(/,/g, '')) || 0;
     campaigns.push({name: parts[0], account, type: parts[typeIdx], impr, clicks, conv});
   }
   campaigns.forEach((c, i) => console.log(`[GA_SCRAPE_v1] ${i.toString().padStart(2,'0')}|${c.name}|${c.account}|${c.type}|${c.impr}|${c.clicks}|${c.conv}`));
   console.log(`[GA_SCRAPE_v1_END] count=${campaigns.length}`);
   campaigns.length;
   ```

4. **Read back via console log markers** using `mcp__claude-in-chrome__read_console_messages` with `pattern: "GA_SCRAPE_v1"`. The output gets reconstructed into JSON and written to `.runs/_iterate-cross-ga-raw.json`. Use the marker-based pipe protocol (not direct JS return) because the return-value channel truncates above ~2KB and we routinely scrape 40+ campaigns.

5. The scraped JSON shape:

   ```json
   {
     "scraped_at": "<ISO timestamp>",
     "date_range_label": "<UI label, e.g. '26 Feb - 12 May 2026'>",
     "campaigns": [
       {"name": "xpredict", "account": "Lee MVP", "type": "Performance Max", "impr": 29453, "clicks": 1082, "conv": 94},
       ...
     ]
   }
   ```

If the scrape fails (no permission, DOM changed, etc.), retry once. If it still
fails, write an empty `{"campaigns": []}` blob and continue — state-x0a is
opt-out; the rest of the skill must run regardless.

### Step 3: Bucket + merge (ALWAYS runs)

This step runs in every code path — even silent-skip — because the merge
subcommand normalizes `ga_clicks=0` on every existing MVP record. That is
how the POSTCONDITION (every record has `ga_clicks` field) gets satisfied
when no GA data was scraped.

```bash
python3 .claude/scripts/lib/iterate_cross_ga.py merge \
  --ga-raw .runs/_iterate-cross-ga-raw.json \
  --ga-csv .runs/iterate-cross-ga-clicks.csv \
  --context .runs/iterate-cross-context.json \
  --config experiment/iterate-cross-config.yaml \
  --unmatched-out .runs/_iterate-cross-ga-unmatched.json
```

This:
- Buckets each campaign to an MVP using `match_key` substring matching on the
  stripped campaign name (xpredict → x-predict, brigent-search-v2 → brigent).
- Honors operator-declared `ga_campaign_aliases` from
  `experiment/iterate-cross-config.yaml` for campaign names that don't
  substring-match (StaylicaAi-Lew → stylica-ai, PubCheck → verify).
- Auto-creates `ga_only: true` synthetic MVP records for campaigns with paid
  clicks and no PostHog presence (state-x1a's `ga_clicks_without_ph_traffic`
  flag picks these up).
- Writes unmatched campaigns to `.runs/_iterate-cross-ga-unmatched.json`
  (placeholder names like "Campaign #1" land here — operator triage).
- Idempotent: re-runs overwrite `ga_clicks` cleanly (no double-counting).
- Silent-skip path: with empty `campaigns` list, the loop sets `ga_clicks=0`
  on every existing MVP record and adds no `ga_only` records — POSTCONDITION
  satisfied without any side effects.

### Step 4: Cleanup

```bash
rm -f .runs/_iterate-cross-ga-raw.json
```

**POSTCONDITIONS:**
- Every MVP record in `.runs/iterate-cross-context.json` has `ga_clicks` field (≥0)
- New `ga_only` MVPs appended when GA campaigns lack a PH match (e.g., reset-app, commissioniq, sdr-copilot)
- `.runs/_iterate-cross-ga-unmatched.json` exists (may be empty array)

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x0a`.

```bash
python3 -c "import json, os; d=json.load(open('.runs/iterate-cross-context.json')); ms=d.get('mvps',[]); assert isinstance(ms, list) and len(ms)>0, 'mvps empty'; bad=[m.get('name','?') for m in ms if 'ga_clicks' not in m]; assert not bad, 'MVPs missing ga_clicks (x0a must run even on silent-skip path): %s' % bad; assert os.path.isfile('.runs/_iterate-cross-ga-unmatched.json'), 'unmatched triage file missing (x0a postcondition)'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x0a
```

**NEXT:** Read [state-x1-gather-all-data.md](state-x1-gather-all-data.md) to continue.
