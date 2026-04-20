# STATE 9: SAVE_PATTERNS

**PRECONDITIONS:**
- Side-effect scan complete (STATE 8b POSTCONDITIONS met)

**ACTIONS:**

Sediment composite patterns so future /resolve runs don't re-derive what this
run already learned. Entries travel one of two paths depending on whether this
repo is `magpiexyz-lab/mvp-template` or a downstream fork (HC1).

### Step 1 — Assemble composite trace per resolved issue

Read all of the following artifacts produced earlier in the run:

- `.runs/resolve-triage.json` — issue type, severity, action
- `.runs/resolve-reproduction.json` — `divergence_point`, `expected`, `actual`
- `.runs/resolve-clusters.json` — cluster `root_cause` per issue
- `.runs/solve-trace.json` — `problem_decomposition`, `prevention_analysis`,
  `solution_design`, `self_check`
- `.runs/agent-traces/resolve-challenger.json` — challenge verdicts
- `.runs/agent-traces/solve-critic.json` (full mode only) — TYPE A/B/C concerns
- `.runs/resolve-validation.json` — regression-check proof
- `.runs/resolve-review.json` — review counts

For each resolved issue (skip issues in `ctx.rejected_issues`), derive a
`composite_identity`:

- `root_cause_class` — keyword-canonicalized distillation of
  `solve-trace.problem_decomposition` ("missing archetype guard",
  "demo mode leak in production", "rate limit bypass", etc.). One short phrase.
- `divergence_pattern` — structural shape of `resolve-reproduction.divergence_point`
  ("env-var-check-missing", "condition-branch-absent", "validator-gap"). One phrase.
- `stack_scope` — primary stack slug inferred from `ctx.blast_radius` paths via
  the mapping `.claude/stacks/<category>/<value>.md`. Pick the stack with the
  most blast-radius hits; ties broken by first-appearance.

### Step 2 — Hash + within-run dedup

Compute the 12-char hash for each composite via
`scripts/lib/stack_knowledge_parser.py::compute_hash`. Group resolved issues by
hash. One entry per unique hash with `occurrence_count = <group size>` and
`linked_issues = [#N, …]`.

### Step 3 — Repository detection

```bash
REPO=$(gh api /repos/:owner/:repo --jq .full_name 2>/dev/null || echo "")
```

If `gh` returns non-zero: set `gh_failed=true`, leave `REPO=""`. Do NOT raise —
the VERIFY shim still passes via the legacy `patterns-saved.json` path.

### Step 4 — Upstream dedup query (per unique hash)

```bash
gh api "/search/issues?q=%5Bpattern-proposal:<HASH>%5D+in:title+repo:magpiexyz-lab/mvp-template" \
  --jq '.total_count' 2>/dev/null
```

On `gh` error: set `gh_failed=true`, record the entry in `pending_proposals`,
move on to the next entry.

### Step 5 — Dispatch

For each unique-hash entry (skip when `gh_failed=true` — already in
`pending_proposals`):

- **Upstream issue already exists** (`total_count >= 1`): comment
  `"Occurrence +1 from /resolve run <run_id>. Linked issue: #<N>."` on that
  issue. Record the URL in `proposals_filed`.
- **`REPO == "magpiexyz-lab/mvp-template"`** (template repo, no existing upstream):
  append the entry's fenced YAML to the `## Stack Knowledge` section of
  `.claude/stacks/<stack_scope>.md`. Create the section at end-of-file if
  absent. Each entry's composite_identity_hash MUST match a fresh
  `compute_hash(composite_identity)` — the PR validator rejects drift.
- **Downstream** (`REPO != "magpiexyz-lab/mvp-template"`, no existing upstream):
  file a new upstream issue:
  ```bash
  gh issue create --repo magpiexyz-lab/mvp-template \
    --label pattern-proposal \
    --title "[pattern-proposal:<HASH>] <one-line summary>" \
    --body "<fenced YAML entry + evidence block citing local issue + run_id>"
  ```
  Record the returned URL in `proposals_filed`.

On any `gh` failure during Step 5: record the entry in `pending_proposals`,
set `gh_failed=true`, print a warning, continue.

### Step 6 — Continue project auto-memory (legacy accelerator)

Also save a 1–2 line pattern summary to the project's auto memory under the
"Resolution Patterns" heading, unchanged from the prior behavior. This is a
local accelerator for the current project only.

Skip Steps 1–5 (leave `learnings=[]`, set `skipped_reason`) when all resolved
issues are trivial (typo fixes, single-character changes, etc.) unlikely to
recur.

### Step 7 — Write new artifact `.runs/resolve-learnings.json`

```bash
python3 -c "
import json
out = {
    'run_id': '<from .runs/resolve-context.json>',
    'learnings': [ ... ],           # one entry per unique composite_identity_hash
    'target_stacks': [ ... ],       # stack slugs matched (e.g. framework/nextjs)
    'proposals_filed': [ ... ],     # upstream issue URLs (or [])
    'halt_events': [],
    'gh_failed': False,
    'pending_proposals': [],        # entries skipped due to gh failure
    'skipped_reason': ''            # set only when Steps 1-5 are skipped
}
json.dump(out, open('.runs/resolve-learnings.json', 'w'), indent=2)
"
```

The `resolve-learnings-gate.sh` hook enforces the schema invariants on write.

### Step 8 — Continue writing legacy `.runs/patterns-saved.json` (shim)

For one release cycle, keep writing the legacy artifact so in-flight /resolve
runs pre-dating this PR don't break. The VERIFY accepts either artifact.

```bash
python3 -c "
import json
legacy = {
    'patterns_saved': [],  # parallel descriptions kept for memory-style fallback
    'skipped_reason': ''
}
json.dump(legacy, open('.runs/patterns-saved.json', 'w'), indent=2)
"
```

**POSTCONDITIONS:**
- `.runs/resolve-learnings.json` exists with required schema fields
- `.runs/patterns-saved.json` exists (shim — legacy schema)
- In the template repo: matched `.claude/stacks/<slug>.md` files have new/updated
  `## Stack Knowledge` entries (or section skipped due to `gh_failed`)
- In a downstream repo: `proposals_filed` lists upstream pattern-proposal issue
  URLs (or `pending_proposals` records what was skipped)
- Resolution-pattern summary saved to auto memory (legacy accelerator)

**VERIFY:**
```bash
python3 -c "import json, os; r='.runs/resolve-learnings.json'; l='.runs/patterns-saved.json'; assert os.path.exists(r) or os.path.exists(l), 'no learnings artifact'; d=json.load(open(r if os.path.exists(r) else l)); new_schema=isinstance(d.get('learnings'), list); legacy_schema=isinstance(d.get('patterns_saved'), list); assert new_schema or legacy_schema; assert (not new_schema) or ('proposals_filed' in d and 'halt_events' in d)"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh resolve 9
```

**NEXT:** Read [state-9a-graduate-external.md](state-9a-graduate-external.md) to continue.
