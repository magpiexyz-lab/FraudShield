# STATE 3b: QUALITY_GATE

**PRECONDITIONS:** STATE 3a complete (per-page and shared design-critic traces exist, build passes).

**ACTIONS:**

#### Stage 2: Consistency check + merge

##### Step A: Lead merges per-page traces

Before spawning the consistency checker, the lead merges per-page traces into `design-critic.json`:

```bash
python3 -c "
import json, glob, os
batches = sorted(glob.glob('.runs/agent-traces/design-critic-*.json'))
if not batches:
    exit(1)
run_id = ''
try:
    run_id = json.load(open('.runs/verify-context.json')).get('run_id', '')
except:
    pass
merged = {'agent': 'design-critic', 'pages_reviewed': 0, 'min_score': 10, 'verdict': 'pass',
          'checks_performed': [], 'pages': len(batches), 'consistency_fixes': 0,
          'sections_below_8': 0, 'fixes_applied': 0, 'unresolved_sections': 0,
          'min_score_all': 10, 'pre_existing_debt': [], 'fixes': [], 'run_id': run_id}
worst_verdicts = {'unresolved': 3, 'fixed': 2, 'pass': 1}
for b in batches:
    d = json.load(open(b))
    merged['pages_reviewed'] += d.get('pages_reviewed', 1)
    merged['min_score'] = min(merged['min_score'], d.get('min_score', 10))
    merged['min_score_all'] = min(merged['min_score_all'], d.get('min_score_all', 10))
    merged['checks_performed'].extend(d.get('checks_performed', []))
    merged['sections_below_8'] += d.get('sections_below_8', 0)
    merged['fixes_applied'] += d.get('fixes_applied', 0)
    merged['unresolved_sections'] += d.get('unresolved_sections', 0)
    debt = d.get('pre_existing_debt', [])
    if isinstance(debt, list):
        merged['pre_existing_debt'].extend(debt)
    page_fixes = d.get('fixes', [])
    if isinstance(page_fixes, list):
        merged['fixes'].extend(page_fixes)
    bv = d.get('verdict', 'pass')
    if worst_verdicts.get(bv, 0) > worst_verdicts.get(merged['verdict'], 0):
        merged['verdict'] = bv
        merged['weakest_page'] = d.get('weakest_page', d.get('page', ''))
    if d.get('retry_attempted'):
        merged['retry_attempted'] = True
# Stage 1c shared-component verdict upgrade
shared_path = '.runs/agent-traces/design-critic-shared.json'
if os.path.exists(shared_path):
    shared = json.load(open(shared_path))
    shared_v = shared.get('verdict', '')
    shared_fixes = shared.get('fixes_applied', 0)
    merged['shared_fixes_applied'] = shared_fixes
    # If only unresolved issues were shared-component, and shared agent fixed them:
    if merged['verdict'] == 'unresolved' and shared_v in ('pass', 'fixed'):
        if shared_fixes > 0 and merged['unresolved_sections'] <= shared_fixes:
            merged['verdict'] = 'fixed'
            merged['unresolved_sections'] = 0
import datetime
merged['timestamp'] = datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
with open('.runs/agent-traces/design-critic.json', 'w') as f:
    json.dump(merged, f)
"
```

After writing the merged trace, validate merge correctness:
```bash
python3 -c "
import json, glob
merged = json.load(open('.runs/agent-traces/design-critic.json'))
pages = sorted(glob.glob('.runs/agent-traces/design-critic-*.json'))
pages = [p for p in pages if 'shared' not in p and p != '.runs/agent-traces/design-critic.json']
total_checks = sum(len(json.load(open(p)).get('checks_performed', [])) for p in pages)
merged_checks = len(merged.get('checks_performed', []))
if merged_checks != total_checks:
    print(f'WARN: Merge mismatch — per-page total {total_checks}, merged {merged_checks}')
else:
    print(f'Merge validation: PASS ({merged_checks} checks)')
"
```

> **Do NOT delete per-page traces** — the consistency checker needs them for cross-page comparison.

##### Step B: Spawn consistency checker (cross-page visual review only)

Spawn the `design-consistency-checker` agent (`subagent_type: design-consistency-checker`). It reads per-page traces and screenshots all pages for cross-page consistency — but does NOT merge traces or fix code.

Pass:
- `base_url`: `http://localhost:3000`
- `run_id`: from verify-context.json
- List of pages reviewed

**Wait for completion.** Handle exhaustion per [Exhaustion Protocol](../verify.md#exhaustion-protocol) Tier 2.

#### Post-design-critic lint gate

After ALL per-page agents + Stage 1b + Stage 2 (consistency check) complete:

1. Run: `npm run build && npm run lint`
2. If lint errors (not warnings):
   - Fix unused imports (max 2 attempts) — this is the most common issue after multi-agent edits
   - Append each fix to `.runs/fix-log.md`: `Fix (lint-gate): <file> — removed unused import`
3. If build errors: fix (max 2 attempts), append to fix-log
4. Re-run `npm run build && npm run lint` to confirm clean.

> **Downstream compatibility**: skill-agent-gate.sh and gate-keeper BG3 check the merged `design-critic.json` — no changes needed. `agents_completed` still lists `"design-critic"` (singular).

#### Lead-side validation (design-critic)

1. Read `.runs/agent-traces/design-critic.json` trace (merged by lead in Step A).
2. Verify `pages_reviewed` >= number of discovered pages (filesystem + golden_path union).
3. If `verdict` == `"unresolved"`, this is a **hard gate failure** — design quality threshold (8/10) was not met after 2 fix attempts. Skip STATEs 4-6 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns). Report failure to user with the `unresolved_sections` count.
4. If `min_score` < 8 and `verdict` == `"fixed"`, note in verify report that threshold was met after fixes.
5. If `pre_existing_debt` is non-empty, note pre-existing quality debt in verify report (informational, does not block).
6. Extract Fix Summaries from per-page agent return messages. Append each fix to `.runs/fix-log.md` with the prefix `Fix (design-critic):`.
7. Note `pages` count and `consistency_fixes` count in verify report.

### Lead-applied fixes from Phase 1 findings

After reviewing Phase 1 agent findings (spec-reviewer, accessibility-scanner, behavior-verifier, performance-reporter) and applying any fixes directly (not via a Phase 2 agent), append each fix to `.runs/fix-log.md`:

```
Fix (lead-<source>): `<file>` — Symptom: <what agent found> — Fix: <what you changed>
```

Sources: `lead-spec-reviewer`, `lead-a11y`, `lead-behavior-verifier`, `lead-perf`.

> **Why:** Phase 1 agents are read-only. When the lead acts on their findings, those fixes must be logged or STATE 6 (Auto-Observe) cannot evaluate them for template-rooted issues.

**POSTCONDITIONS:**
- Merged `design-critic.json` trace exists in `.runs/agent-traces/`
- `design-consistency-checker.json` trace exists (when scope is `full` or `visual` AND archetype is `web-app`)
- Build and lint pass after all fixes
- Lead-applied fixes from Phase 1 findings logged in `fix-log.md`

**VERIFY:**
```bash
test -f .runs/agent-traces/design-critic.json && python3 -c "import json; assert json.load(open('.runs/build-result.json'))['exit_code']==0"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 3b
```

**NEXT:** Read [state-3c-ux-merge.md](state-3c-ux-merge.md) to continue.
