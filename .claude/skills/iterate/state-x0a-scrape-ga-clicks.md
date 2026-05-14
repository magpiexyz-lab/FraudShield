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

When Chrome MCP is available, the lead agent drives the scrape inline.

**Why per-sub-account, not the MCC parent page.** The MCC parent campaigns table
uses Particle UI virtualization — only ~12 of 49+ rows ever exist in the DOM,
and programmatic `scrollTop` does NOT trigger new renders. The MCC page also
loads `UiCustomizationService/List` (the cross-account chooser dropdown's
dependency), which hangs indefinitely on MCP-reused tabs and surfaces as a
generic "Turn off ad blockers" fallback page. Per-sub-account pages
(`/aw/campaigns?ocid=<sub>` without `workspaceId`) render ≤10 rows each (no
virtualization) and don't depend on `UiCustomizationService`. Combined with
always-fresh-tab discipline this defeats both failure modes documented in the
2026-05-14 session.

#### Step 2.0: Always-fresh tab

MCP-reused Google Ads tabs accumulate state that hangs `UiCustomizationService`.
Close any existing `ads.google.com` MCP tab and create a new one for every
x0a invocation. Cost is ~1s; eliminates that whole failure class. The
operator's non-MCP Chrome tab is unaffected — it shares cookies but not
MCP-tab state.

```
# 1. Snapshot current MCP tabs WITHOUT auto-creating.
ctx = mcp__claude-in-chrome__tabs_context_mcp()

# 2. Close any tab on ads.google.com (forces fresh session state).
for t in ctx.availableTabs:
    if 'ads.google.com' in t.url:
        mcp__claude-in-chrome__tabs_close_mcp(tabId=t.tabId)

# 3. Re-snapshot; createIfEmpty=true rebuilds the MCP group if step 2
#    closed the last tab (group auto-removes on last close).
ctx2 = mcp__claude-in-chrome__tabs_context_mcp(createIfEmpty=true)
fresh_tab_id = ctx2.availableTabs[0].tabId

# 4. Navigate to /aw/overview to pin authuser=2 before account-scoped URLs.
mcp__claude-in-chrome__navigate(tabId=fresh_tab_id, url='https://ads.google.com/aw/overview?authuser=2')
```

The initial `/aw/overview` nav pins `authuser=2` before any account-scoped
URLs. If the operator has a single Google session this is a no-op. Step 3
intentionally avoids `tabs_create_mcp()` — `createIfEmpty=true` returns the
existing tab (if any non-Google tab survived) or creates a single fresh one.
This prevents accidentally creating two tabs when no ads.google.com tab
existed.

#### Step 2.1: Discover sub-accounts (every run, no cache)

Navigate the fresh tab to `https://ads.google.com/aw/accounts?authuser=2`.
The accounts table is small (~6–15 rows) — no virtualization workaround
needed. Scrape via `mcp__claude-in-chrome__javascript_tool`:

```js
const links = Array.from(document.querySelectorAll('a[href*="/aw/overview?ocid="]'));
const seen = new Set();
const accounts = [];
for (const a of links) {
  const m = a.href.match(/ocid=(\d{8,})/);
  if (!m) continue;
  const ocid = m[1];
  if (seen.has(ocid)) continue;
  seen.add(ocid);
  const row = a.closest('[role="row"]') || a.closest('.particle-table-row') || a.parentElement;
  const name = (row?.innerText || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || `acct-${ocid}`;
  accounts.push({ocid, name});
}
accounts.forEach((a, i) => console.log(`[GA_ACCT_v1] ${i.toString().padStart(2,'0')}|${a.ocid}|${a.name}`));
console.log(`[GA_ACCT_v1_END] count=${accounts.length}`);
accounts.length;
```

Read back via `mcp__claude-in-chrome__read_console_messages` with
`pattern: "GA_ACCT_v1"`. Parse marker lines into `[{ocid, name}, ...]`.

If `count < 3` (heuristic floor — operator likely has ≥3 sub-accounts),
retry the page nav once with a 3s wait. If still <3, write
`{"campaigns": []}` to `.runs/_iterate-cross-ga-raw.json` and skip to
Step 3 (silent-skip path). Do NOT bail the whole state.

#### Step 2.2: Per-sub-account scrape loop

Compute the date-range URL parameter from `context.window_days`:

```python
import datetime, json
window_days = json.load(open('.runs/iterate-cross-context.json')).get('window_days', 90)
today = datetime.date.today()
start = today - datetime.timedelta(days=window_days - 1)
dr = f"{start.strftime('%Y%m%d')}~{today.strftime('%Y%m%d')}"
```

Google Ads' campaigns page honors `&dr=YYYYMMDD~YYYYMMDD` on initial load,
which sets the date filter without touching the date-picker UI (which has
the same `UiCustomizationService` failure mode as the MCC chooser).

For each `(ocid, name)` discovered in Step 2.1:

a. **Navigate** the fresh tab to:
   ```
   https://ads.google.com/aw/campaigns?ocid=<ocid>&authuser=2&dr=<dr>
   ```
   Intentionally omit `workspaceId` — sub-account scope removes the
   chooser-dropdown dependency.

b. **Wait for table render.** Poll via `javascript_tool` until at least one
   **campaign** row is rendered (not just summary/totals). The summary row
   (`Total: Campaigns in your current view`) and the drafts overview row
   render BEFORE campaign data; a predicate that only checks for any table
   row would unblock prematurely and the scrape would record 0 campaigns
   while marking the account success.

   Use the same invariant the scraper depends on (`parts[1] === 'settings'`,
   the gear icon column 1 marker that every campaign row has):

   ```js
   [...document.querySelectorAll('[role="row"]')].some(r => {
     const parts = (r.innerText || '').replace(/\n+/g,'|').split('|').map(s=>s.trim()).filter(Boolean);
     return parts[1] === 'settings';
   });
   ```

   Poll with timeout (3 attempts × 3s = 9s max). If timeout, record this
   account in `accounts_failed` with `reason: "render_timeout"` and `continue`
   to the next account — do NOT abort the loop. Empty per-account pages (an
   account with zero campaigns in the window) will also time out here; this
   is acceptable — the merge produces 0 ga_clicks for those MVPs regardless.

c. **Scrape** via the existing row-decoder (`typeIdx`-anchored, marker-piped):

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

d. **Emit date-range chip marker in the SAME javascript_tool execution**
   (so a single console-read in step (e) captures both campaign markers and
   the date marker):

   ```js
   const chip = document.querySelector('material-button[debug-id*="date"], [aria-label*="Date range"]');
   console.log(`[GA_DATE_v1] ${(chip?.innerText || '?').replace(/\s+/g, ' ').trim()}`);
   ```

e. **Read back** via `mcp__claude-in-chrome__read_console_messages` with
   the COMBINED pattern `pattern: "GA_SCRAPE_v1|GA_DATE_v1"` and `clear: true`.
   One call returns both markers. Use marker-piped console (not direct JS
   return) because return-value channel truncates above ~2KB.

   - Parse `[GA_SCRAPE_v1] index|name|account|type|impr|clicks|conv` lines
     into campaign records.
   - Parse the FIRST `[GA_DATE_v1] <chip-text>` line into a chip-text string.
     The first successful account's chip is sufficient — all accounts use
     the same date-range parameter and would show identical chip text.

   `clear: true` is required: without it, the next account's scrape would
   re-parse the previous account's markers and double-count campaigns.

   **Tag every campaign record's `account` field with the current Step 2.1
   `name`** — some Particle layouts omit the account cell when scoped to a
   single account, so the row-decoder may have set `account` to a noise value.

f. Append the per-account campaigns into the accumulating list. Store the
   chip-text from the first successful account in a `date_range_label`
   variable (subsequent accounts overwrite, but the value is stable across
   accounts so this is idempotent). Move on to the next account.

#### Step 2.3: Assemble raw JSON

After the loop, write `.runs/_iterate-cross-ga-raw.json`:

```json
{
  "scraped_at": "<ISO timestamp>",
  "window_days": 90,
  "date_range_dr": "20260213~20260514",
  "date_range_label": "<from chip>",
  "accounts_scraped": [{"ocid": "...", "name": "..."}, ...],
  "accounts_failed": [{"ocid": "...", "name": "...", "reason": "render_timeout|nav_error"}, ...],
  "campaigns": [
    {"name": "xpredict", "account": "Lee MVP", "type": "Performance Max", "impr": 29453, "clicks": 1082, "conv": 94},
    ...
  ]
}
```

The `campaigns: [...]` shape is identical to the legacy MCC scrape, so
Step 3 (merge) consumes it unchanged. The new top-level audit fields are
picked up by `cmd_merge`'s observability print when present, and ignored
otherwise:

- `accounts_scraped` — list of accounts where the wait predicate (Step 2.2.b)
  passed AND scraping ran (success path). An account here may have 0 campaigns
  in its `campaigns` contribution (legitimately empty account in the window).
- `accounts_failed` — list of accounts where the wait predicate timed out
  or navigation errored. Mutually exclusive with `accounts_scraped`.
- `window_days` — from `context.window_days` (input).
- `date_range_dr` — the `&dr=YYYYMMDD~YYYYMMDD` URL parameter passed to
  per-account navigation (intended window).
- `date_range_label` — the chip text actually rendered by Google Ads UI
  (observed window — should match `date_range_dr`, but see Step 2.4 sanity
  check).

#### Step 2.4: Soft sanity checks (warn-only, never blocking)

Before exiting Step 2:

- If `len(accounts_failed) > 0`: print to stderr
  `WARN: x0a partial — N/M sub-accounts failed: <names>. Drop CSV at .runs/iterate-cross-ga-clicks.csv to backfill, or re-run.`

- **Date-range mismatch check.** The `&dr=YYYYMMDD~YYYYMMDD` URL parameter is
  not officially documented by Google; if it ever stops working, the chip
  shows a UI default (e.g., "Today", "Last 7 days") and the scrape uses
  the wrong window — producing silently-wrong denominators. Detect by
  checking `date_range_label` from the chip against the expected window:

  ```python
  import datetime, re
  expected_start = today - datetime.timedelta(days=window_days - 1)
  expected_end = today
  label = raw['date_range_label'] or ''
  ok = (
      str(expected_start.year) in label
      and str(expected_end.year) in label
      and any(m in label for m in [expected_start.strftime('%b'), expected_start.strftime('%B')])
      and any(m in label for m in [expected_end.strftime('%b'), expected_end.strftime('%B')])
  )
  if not ok:
      print(
          f"WARN: x0a date-range mismatch — chip='{label}' does not contain "
          f"expected window {expected_start} → {expected_end} ({window_days}d). "
          f"&dr= URL param may have stopped working; ga_clicks will reflect "
          f"the UI default instead of window_days. Verify with operator-CSV "
          f"path or open an issue.",
          file=sys.stderr,
      )
  ```

  Heuristic — accepts labels like `"26 Feb - 14 May 2026"`, `"Feb 13 - May 14, 2026"`,
  `"Feb 13, 2026 - May 14, 2026"`. Rejects shorter labels like `"Today"`,
  `"Last 7 days"`, `"Yesterday"`. Soft-fails (warn-only); does not block.

- If `sum(c.clicks for c in campaigns) == 0` AND `len(accounts_scraped) > 0`:
  print `WARN: zero clicks scraped — check date_range_label='<X>' vs window_days=N`.

All warnings are stderr-only. POSTCONDITION (every MVP has `ga_clicks` field
after merge) is still met by Step 3 running.

**Total scrape failure** (Chrome MCP unavailable mid-loop, or every account
render-timed out): write `{"campaigns": []}` to the raw JSON and continue
to Step 3 — same as the silent-skip path. The rest of the skill must run
regardless.

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
