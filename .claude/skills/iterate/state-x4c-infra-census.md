# STATE x4c: INFRA_CENSUS

Off-fleet infrastructure census: enumerate Supabase / Railway / Vercel
projects + GitHub org repos, join them into clusters, classify each cluster's
lifecycle, and route owner proposals through the operator-confirm flow. The
fleet loop's discovery root is paid traffic (state-x0), but **cost attaches to
resource existence** — projects provisioned before ads start (or abandoned
before ads ever ran) bill invisibly. This state closes that gap (2026-08-04
audit: 53 unmapped ACTIVE Supabase projects ≈ $530+/mo at the Micro floor).

## Why this state exists

The lifecycle is `repo → deploy → DB → … → ads`, but cross only sees an MVP
once ads produce gclid traffic. Everything left of "ads" is spend without
governance: work-in-progress (legitimate, will graduate into the fleet),
abandoned pre-ads experiments (pure waste), and shared infrastructure
(legitimate forever, needs an allowlist). The census makes the invariant
enforceable: **every billed resource has an owner and a lifecycle state, or it
becomes a pause proposal.**

**PRECONDITIONS:**
- STATE x4b POSTCONDITIONS met (teardown reconcile complete — census is its
  mirror: teardown governs known-killed resources, census governs unknown ones)
- Supabase / Railway / Vercel / gh credentials as available (every collector
  is fail-soft; a platform being down degrades coverage, never the run)

**ACTIONS:**

### Step 1: Scan (enumerate + join + classify)

```bash
python3 .claude/scripts/lib/iterate_cross_census.py scan \
  --config experiment/iterate-cross-config.yaml \
  --output .runs/iterate-cross-census.json
```

Joins (strongest first): Vercel `repo_slug` → repo (machine link); repo
description `"<name>: …"` prefix / org name-index → canonical name;
cross-platform name co-occurrence via `match_key`. Classification:

| Class | Meaning | Consequence |
|-------|---------|-------------|
| `fleet` | matches an mvp_mappings row | governed by the normal cross loop |
| `shared_infra` | `census.shared_infra` allowlist | exempt, rendered as its own cost line |
| `claimed` | `census.claims` has an operator-confirmed owner | tracked, no action |
| `active` | pushed/deployed within `census.active_window_days` (default 30) | pre-ads work in progress — NEVER pause-proposed; graduates into the fleet via x0 once ads start |
| `dormant` | has a repo, no recent activity, no ads history | pause candidate (operator-confirmed) |
| `unjoined` | no repo/activity evidence | human claim queue |

### Step 2: Owner proposals (off-fleet clusters)

```bash
python3 .claude/scripts/lib/iterate_cross_census.py propose-owners \
  --config experiment/iterate-cross-config.yaml \
  --census .runs/iterate-cross-census.json \
  --output .runs/_iterate-cross-census-owners.json
```

Reuses the fleet owner channel machinery verbatim (commit history
first+majority via `iterate_cross_owner_infer`, departed→operator remap,
Vercel deploy-author fallback) so confidence semantics stay identical, plus
three census-specific last-resort channels (all fail-soft, config-gated):

- **db-fingerprint** (`census.db_fingerprint_probe`): the builder almost
  always test-signs-up within days of creating the project. First
  `auth.users` registrants inside `census.fingerprint_window_days` of the
  project's `created_at` are matched against roster emails — exact match →
  proposal (`high` when the sole in-window registrant, `medium` otherwise);
  non-roster registrants are attached redacted to the `needs_claim` entry as
  playbook evidence, NEVER auto-proposed (2026-08-04 exemplars:
  mercator-protocol→lego, permitpilot→bhavin).
- **Railway source repo** (`census.railway_source_probe`): each service's
  Settings→Source Repo, read via the public GraphQL API
  (`serviceInstance.source.repo`; CLI session token from
  `~/.railway/config.json` `.user.accessToken`). Persistent service config —
  survives GitHub repo deletion ("GitHub Repo not found" in the dashboard)
  and offline services, exactly where the GIT-vars probe is blind. A
  personal repo's owner login → direct medium proposal; org-owned sources
  stay `needs_claim` evidence (`railway_source: [...]`). Runs before the
  GIT-vars probe — one API call per project vs per-service CLI
  link+variables (2026-08-06 exemplars: courageous-gentleness +
  Outcome-Oracle→bhavin, genuine-caring→karan, StreakBet→taran — closed the
  census tail 7→0).
- **Railway GIT metadata** (`census.railway_git_probe`): GitHub-connected
  services carry `RAILWAY_GIT_REPO_*` + `RAILWAY_GIT_AUTHOR` (the deployer's
  GitHub login → direct medium proposal). CLI-deployed (`railway up`) and
  image services carry none — absence is recorded as `railway_git: none`
  evidence, not treated as failure.

The name join is suffix- and typo-tolerant (`kol-finder-worker` ↔
`kol-finder`; the `Liquidity-Srategy` repo typo) with an ambiguity guard
(two distance-1 candidates → no join); proposals derived from a fuzzy-joined
repo are confidence-capped at `medium`. The scan also reconciles GitHub-org
and Supabase-org member lists against `team_roster` and reports
`roster_gaps` — an unrostered member silently disables owner inference for
their whole portfolio (this channel exposed 5 missing roster rows on
2026-08-04).

Render the proposals + the `needs_claim` tail to the operator. **On
confirmation only**, persist:

```bash
python3 .claude/scripts/lib/iterate_cross_census.py persist-claims \
  --input .runs/_iterate-cross-census-owners.json \
  --config experiment/iterate-cross-config.yaml \
  [--shared-infra <name> ...] \
  --confirm
```

Claims land in the config `census:` section — NEVER in `mvp_mappings`
(off-fleet clusters are not MVPs and must not feed the verdict machinery).
Existing claims are never overwritten; owners must be active roster members.

### Attribution playbook (lead judgment for the residual tail)

For clusters the mechanized channels cannot resolve, the lead applies these
moves against the evidence attached to `needs_claim` entries (each proved in
the 2026-08-04 sweep, 64→7):

1. **Wallet cross-linkage** — the same wallet address appearing in two
   projects' data means one builder (`CpUt6XZf…` linked liquidity-strategy
   and node-wars to one owner).
2. **In-app self-identification** — signature/free-text rows sometimes name
   the builder outright (sc-leveraged stored a wallet signature reading "my
   name deepakpalrocks on the Silicon Colesium Live Trading app").
3. **Table-family matching** — near-identical public schemas mean the same
   builder iterating (beepia ≡ parliament).
4. **Personal-email first-registrant reasoning** — a creation-day personal
   gmail plus a teammate work-email nearby is a strong lead but stays an
   operator ruling, never an auto-claim (permitpilot).
5. **Roster-gap reading** — an unmatched org member is usually a missing
   roster row, not a stranger; add the row (`github`/`github_aliases`/
   `email`), then re-run propose — one roster fix can unlock a whole
   portfolio.

### Known-dead channels (measured 2026-08-04 — do not re-derive)

- Supabase **audit logs are Team-plan-gated** (`/v1/organizations/{slug}/audit*`
  404s on Pro) and project objects carry **no `created_by`** — historical
  creator attribution via API is impossible on this plan.
- Railway **CLI-deployed and image services carry no `RAILWAY_GIT_*` and no
  `source.repo`** (contrast case: dryrunsec HAS an org repo yet showed no
  GIT vars — it was `railway up`-deployed). The 2026-08-04 claim that the
  public GraphQL API rejects the CLI token was a misdiagnosis, CORRECTED
  2026-08-06 — two stacked traps: (a) Cloudflare bans urllib's default
  `Python-urllib/3.x` User-Agent with 403 "error code: 1010" regardless of
  auth (any other UA passes); (b) `~/.railway/config.json` `.user.token` is
  a legacy null field — the live token is `.user.accessToken`. With both
  fixed, `serviceInstance.source.repo` is fully readable via the CLI session
  token — that signal is now the **Railway source repo** channel above.
- `gh search code` is **unreliable on private org repos** — strings known to
  exist return zero hits; absence of code-search hits proves nothing.

### Step 3: Report

Render to the operator: classification counts, the off-fleet Supabase cost
floor, dormant pause-candidates (with owners where inferred), and the
unclaimed tail (feeds the team claim message). Dormant-cluster pausing is a
manual operator action in the platform dashboards for now (Management-API
pause automation is future work) — the census's job is to make the list
correct, current, and owned.

### Cleanup

```bash
rm -f .runs/_iterate-cross-census-owners.json
```

### Step 4: delivery artifacts (record delivery of the run's data)

x4c is the LAST state that mutates `experiment/` in cross mode (x4a wrote the
ledger + run-metrics + archive; x4b stamped teardown fields; this state may
have persisted census claims). Writing the delivery trio here — and only
here — means `lifecycle-finalize.sh`'s record-delivery seam commits ALL of it
in one branch-guarded PR (auto-squash-merge per the standing auto-merge
gates). Writing it earlier (e.g. at x4a) would strand x4b/x4c mutations when
the ledger itself happened not to change.

```bash
if [ -n "$(git status --porcelain -- experiment/ 2>/dev/null)" ]; then
  RUN_DATE=$(date -u +%Y-%m-%d)
  printf 'Record iterate-cross %s run: ledger + run-metrics + archive\n' "$RUN_DATE" \
    > .runs/commit-message.txt
  printf 'Record iterate-cross %s run data\n' "$RUN_DATE" > .runs/pr-title.txt
  {
    printf '**⚠️ Post-merge steps:** None\n\n## Summary\n\n'
    printf 'Automated data delivery from the /iterate --cross %s run: decision-ledger upsert, ' "$RUN_DATE"
    printf 'append-only run-metrics rows, raw-evidence archive (consumed GA CSV + scores), and any '
    printf 'operator-confirmed census claims/teardown stamps.\n\n## What Changed\n\n'
    git status --porcelain -- experiment/ | sed 's/^/- `/; s/$/`/'
    printf '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
  } > .runs/pr-body.md
  echo "delivery artifacts written (experiment/ changed)"
else
  echo "no experiment/ changes — delivery skipped"
fi
```

**POSTCONDITIONS:**
- `.runs/iterate-cross-census.json` exists with `platforms`, `counts`,
  `clusters[]` (each carrying `key`, `classification`, `platforms`), and
  `errors[]` (may be non-empty — fail-soft is by design)
- Owner proposals presented; confirmed claims persisted to config `census:`
- When `experiment/` carries uncommitted changes, `.runs/commit-message.txt`,
  `.runs/pr-title.txt`, and `.runs/pr-body.md` exist (finalize record-delivery)

**VERIFY:** see `state-registry.json` entry for `iterate-cross.x4c`.

```bash
python3 -c "import json; d=json.load(open('.runs/iterate-cross-census.json')); assert isinstance(d.get('clusters'), list) and d.get('platforms') is not None and d.get('counts') is not None, 'census artifact malformed'; bad=[c.get('key','?') for c in d['clusters'] if not c.get('key') or 'classification' not in c or 'platforms' not in c]; assert not bad, 'malformed clusters: %s' % bad" && python3 -c "import os, subprocess; dirty=subprocess.run(['git','status','--porcelain','--','experiment/'],capture_output=True,text=True).stdout.strip(); assert (not dirty) or (os.path.isfile('.runs/commit-message.txt') and os.path.isfile('.runs/pr-title.txt') and os.path.isfile('.runs/pr-body.md')), 'experiment/ changed but delivery artifacts missing'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross x4c
```

**NEXT:** Skill states complete.
