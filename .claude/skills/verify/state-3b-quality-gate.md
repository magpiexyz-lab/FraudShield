# STATE 3b: QUALITY_GATE

**PRECONDITIONS:** STATE 3a complete (per-page and shared design-critic traces exist, build passes).

**ACTIONS:**

#### Stage 2: Consistency check + merge

##### Step A: Lead merges per-page traces

Before spawning the consistency checker, the lead merges per-page traces into `design-critic.json`. The merge logic lives in a dedicated script so `agent-trace-write-guard.sh` can authorise exactly this write (issue #1045 — inline `python3 -c` blocks that open `agent-traces/*` for write are blocked by the guard's open-for-write regex):

```bash
python3 .claude/scripts/merge-design-critic-traces.py
```

Exit codes: `0` merge succeeded, `1` no per-page traces found, `2` per-page trace parse error. Preserves every field the prior inline merge produced (pages_reviewed, min_score, checks_performed, per_page_review_methods, per_page_review_evidence, review_method_gate_corrections, pre_existing_debt, fixes, shared_fixes_applied, run_id, timestamp).

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
3. If `verdict` == `"unresolved"`, this is a **hard gate failure** — design quality threshold (8/10) was not met after 2 fix attempts. Skip STATEs 4-5 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns). Report failure to user with the `unresolved_sections` count.
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

> **Why:** Phase 1 agents are read-only. When the lead acts on their findings, those fixes must be logged or the observation epilogue cannot evaluate them for template-rooted issues.

**POSTCONDITIONS:**
- Merged `design-critic.json` trace exists in `.runs/agent-traces/`
- `design-consistency-checker.json` trace exists (when scope is `full` or `visual` AND archetype is `web-app`)
- Build and lint pass after all fixes
- Lead-applied fixes from Phase 1 findings logged in `fix-log.md`

**VERIFY:**
```bash
python3 -c "import json,os,glob; ctx=json.load(open('.runs/verify-context.json')); needs_dc=ctx.get('scope') in ('full','visual') and ctx.get('archetype')=='web-app'; assert not needs_dc or os.path.exists('.runs/agent-traces/design-critic.json'), 'design-critic.json missing (scope=%s, archetype=%s)' % (ctx.get('scope'),ctx.get('archetype')); assert not needs_dc or os.path.exists('.runs/agent-traces/design-consistency-checker.json'), 'design-consistency-checker.json missing'; assert json.load(open('.runs/build-result.json'))['exit_code']==0; has_candidates=os.path.exists('.runs/image-candidates.json'); dc_traces=glob.glob('.runs/agent-traces/design-critic-*.json') if needs_dc and has_candidates else []; root_checked=any('candidates_tried' in json.load(open(t)) for t in dc_traces) if dc_traces else True; assert root_checked, 'image-candidates.json exists but no design-critic trace contains candidates_tried — Step 5.5 may have been skipped'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 3b
```

**NEXT:** Read [state-3c-ux-merge.md](state-3c-ux-merge.md) to continue.
