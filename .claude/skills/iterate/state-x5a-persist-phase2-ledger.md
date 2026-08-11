# STATE x5a: PERSIST_PHASE2_LEDGER

Persist each Phase-2 MVP's pay-intent verdict + metrics to the **durable,
git-tracked** phase2 decision ledger (`experiment/phase2-decision-ledger.jsonl`),
append the run's Tier-2 run-metrics rows, archive the run's raw inputs, and
write the delivery artifacts so `lifecycle-finalize.sh` commits it all in one
PR. Mirror of state-x4a for `--cross --phase2`.

## Why this state exists

Phase-2 accumulation was re-derived from scratch every run (PostHog + a ≤24h
CSV window): the 2026-07-29 verdict run was destroyed by the 08-03 overwrite,
and terminal calls (handpick NO_GO @ 307 clicks) lived only in gitignored
`.runs/`. Batch verdicts (10+ MVPs × 300 clicks) need a cross-run record, and
the stalled streak/escalation machinery needs a previous-run row to carry
state forward (`annotate_stalled` in x5 reads THIS file on the next run).

Deliberate divergences from the phase-1 ledger (see
`iterate_cross_ledger.py`'s phase-2 section for the full rationale):
- **Raw-name keys** (no canonical/alias collapse) — matches
  `annotate_stalled`'s raw-name lookup; `mvp_canonical` is stamped as a field.
- **No `lifecycle_status` in the snapshot** — phase2 scores don't carry it;
  freeze keys on the operator config (`mvp_mappings.<canonical>.lifecycle_status
  == killed`) and locks the terminal pre-teardown verdict.
- **`run_date` is the data clock** (x5's `reference_now`); `persisted_at` +
  `run_id` carry wall clock + run identity so streaks advance across runs
  whose data clock froze (stopped campaigns).
- **Verdicts are recorded as computed** (operator decision 2026-08-07): the
  batch-verdict policy governs communication and action, not the record.

**PRECONDITIONS:**
- STATE x5 POSTCONDITIONS met (`.runs/iterate-cross-phase2-scores.json` exists
  with `reference_now` + pay-intent metrics; context carries `run_id` and
  `ga_csv_sha256`)

**ACTIONS:**

### Step 1: persist the phase2 ledger (non-destructive upsert)

```bash
REF=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-phase2-scores.json')).get('reference_now') or '')")
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/iterate-cross-phase2-context.json')).get('run_id',''))")
python3 .claude/scripts/lib/iterate_cross_ledger.py persist-phase2 \
  --scores .runs/iterate-cross-phase2-scores.json \
  --ctx .runs/iterate-cross-phase2-context.json \
  --ledger experiment/phase2-decision-ledger.jsonl \
  --config experiment/iterate-cross-config.yaml \
  --now "$REF" \
  --run-id "$RUN_ID"
```

`--now "$REF"` is load-bearing: the writer's `run_date` and the next run's
`annotate_stalled` `reference_now` must share one clock domain, or
`delta_days` goes permanently non-positive and the streak freezes. Orphan
rows are skipped here (no durable identity) — Tier 2 below keeps them.
Spend fields are whitelist-projected from the ctx (`ga_cost/ga_cpc/
ga_currency/ga_conv/ga_impressions` + row-level `ga_campaigns`); the ctx is
NEVER copied whole (its `db_pay_intents_filter_audit` rows carry redacted
end-user emails).

### Step 2: run-metrics telemetry + raw-evidence archive

Tier 2/3 (schemas + PII-guard semantics in
`.claude/scripts/lib/iterate_cross_runlog.py`). Orphan rows ARE included in
run-metrics — they carry the campaign→MVP join. Python-only copies: never
`cp` a gated `.runs/*.json` in bash (gate-artifact-bash-write-guard would
flag the command text and poison the deny-cutover soak signal).

```bash
python3 - <<'PY'
import datetime
import json
import sys

sys.path.insert(0, ".claude/scripts/lib")
from iterate_cross_classify import load_yaml
from iterate_cross_ledger import build_alias_index
from iterate_cross_runlog import append_run_metrics, archive_run_files, build_run_metrics_row

ctx = json.load(open(".runs/iterate-cross-phase2-context.json"))
run_id = ctx.get("run_id")
scores_doc = json.load(open(".runs/iterate-cross-phase2-scores.json"))
persisted_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
alias_index = build_alias_index(load_yaml("experiment/iterate-cross-config.yaml").get("mvp_aliases"))
ctx_by_name = {m.get("name"): m for m in ctx.get("mvps", []) if m.get("name")}

rows = [
    build_run_metrics_row(
        2, run_id, scores_doc.get("reference_now"), persisted_at, s,
        ctx_mvp=ctx_by_name.get(s.get("name")),
        mvp_canonical=alias_index.get(s.get("name"), s.get("name")),
    )
    for s in scores_doc.get("mvps", [])
]
print(f"run-metrics: +{append_run_metrics(rows)} phase-2 rows")

archive_run_files(
    "cross-phase2",
    [(".runs/iterate-cross-ga-clicks.csv", "iterate-cross-ga-clicks.csv"),
     (".runs/iterate-cross-phase2-scores.json", "iterate-cross-phase2-scores.json")],
    run_id,
    expected_csv_sha=ctx.get("ga_csv_sha256"),
)
PY
```

### Step 3: delivery artifacts (record delivery of the run's data)

x5a is the last state that mutates `experiment/` in phase2 mode. Writing the
delivery trio here hands everything to `lifecycle-finalize.sh`'s
record-delivery seam (branch-guarded commit → PR → auto-squash-merge).

```bash
if [ -n "$(git status --porcelain -- experiment/ 2>/dev/null)" ]; then
  RUN_DATE=$(date -u +%Y-%m-%d)
  printf 'Record iterate-cross-phase2 %s run: ledger + run-metrics + archive\n' "$RUN_DATE" \
    > .runs/commit-message.txt
  printf 'Record iterate-cross-phase2 %s run data\n' "$RUN_DATE" > .runs/pr-title.txt
  {
    printf '**⚠️ Post-merge steps:** None\n\n## Summary\n\n'
    printf 'Automated data delivery from the /iterate --cross --phase2 %s run: phase2 ' "$RUN_DATE"
    printf 'decision-ledger upsert, append-only run-metrics rows, and the raw-evidence '
    printf 'archive (consumed GA CSV + phase2 scores).\n\n## What Changed\n\n'
    git status --porcelain -- experiment/ | sed 's/^/- `/; s/$/`/'
    printf '\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
  } > .runs/pr-body.md
  echo "delivery artifacts written (experiment/ changed)"
else
  echo "no experiment/ changes — delivery skipped"
fi
```

**POSTCONDITIONS:**
- `experiment/phase2-decision-ledger.jsonl` exists; every line is valid JSON;
  no duplicate `mvp` keys; no raw-key/canonical collision; every row carries
  `mvp_canonical`, `phase: "phase-2"`, and `current` with `ga_clicks`,
  `last_run`, `run_id`
- `experiment/iterate-cross-run-metrics.jsonl` gained one phase-2 row per
  scored MVP (orphans included) for this `run_id`
- `experiment/runs-archive/` holds this run's consumed GA CSV + phase2 scores
  (or the identical-sha set was already archived) with an `index.jsonl` line
- When `experiment/` carries uncommitted changes, the delivery trio exists

**VERIFY:** see `state-registry.json` entry for `iterate-cross-phase2.x5a`.

```bash
test -f experiment/phase2-decision-ledger.jsonl && python3 -c "import json, os, subprocess, yaml; rows=[json.loads(l) for l in open('experiment/phase2-decision-ledger.jsonl') if l.strip()]; assert rows, 'phase2 ledger empty'; seen=set(); [seen.add(r['mvp']) for r in rows]; assert len(seen)==len(rows), 'duplicate mvp keys in phase2 ledger'; bad=[r.get('mvp','?') for r in rows if not r.get('mvp') or r.get('phase')!='phase-2' or not r.get('mvp_canonical') or not isinstance(r.get('current'),dict) or not isinstance(r.get('verdict_history'),list)]; assert not bad, 'malformed phase2 rows: %s' % bad; cur_bad=[r['mvp'] for r in rows if not {'ga_clicks','last_run','run_id'} <= set((r.get('current') or {}).keys())]; assert not cur_bad, 'phase2 current missing reader-contract fields: %s' % cur_bad; cfg=yaml.safe_load(open('experiment/iterate-cross-config.yaml')) or {}; rev={a:c for c,als in (cfg.get('mvp_aliases') or {}).items() for a in (als or [])}; coll=[k for k in seen if rev.get(k) and rev[k]!=k and rev[k] in seen]; assert not coll, 'alias/canonical dual keys in phase2 ledger: %s' % coll; assert os.path.isfile('experiment/iterate-cross-run-metrics.jsonl'), 'run-metrics jsonl missing'; rid=json.load(open('.runs/iterate-cross-phase2-context.json')).get('run_id'); mrows=[json.loads(l) for l in open('experiment/iterate-cross-run-metrics.jsonl') if l.strip()]; assert any(m.get('run_id')==rid and m.get('phase')==2 for m in mrows), 'no phase-2 run-metrics rows for the active run_id'; dirty=subprocess.run(['git','status','--porcelain','--','experiment/'],capture_output=True,text=True).stdout.strip(); assert (not dirty) or os.path.isfile('.runs/commit-message.txt'), 'experiment/ changed but delivery artifacts missing'"
```
<!-- VERIFY=true: real assertion lives in state-registry.json; this line is the per-Rule-13 placeholder -->

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh iterate-cross-phase2 x5a
```

**NEXT:** Read [.claude/patterns/state-99-epilogue.md](../../patterns/state-99-epilogue.md) to continue.
