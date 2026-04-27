# STATE 3c: UX_MERGE

**PRECONDITIONS:** STATE 3b complete (design-critic.json merged, build and lint pass, lead Phase 1 fixes applied).

**ACTIONS:**

## Archetype Gate

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Visual agents".
>
> [visual-agents] web-app: design-critic, ux-journeyer, consistency-checker | service: skip | cli: skip

### ux-journeyer (if scope is `full` or `visual`, AND archetype is `web-app`) — SERIAL

Spawn the `ux-journeyer` agent (`subagent_type: ux-journeyer`). Pass PR file boundary. **Wait for completion.**
After completion: verify `.runs/agent-traces/ux-journeyer.json` exists; if agent returned output but trace is missing, write a recovery trace with `"recovery":true`.
Run `npm run build`. If build fails, fix (max 2 attempts) before next agent.

#### Lead-side validation (ux-journeyer)

1. Read `.runs/agent-traces/ux-journeyer.json` trace.
2. **Invoke review-verdict-gate** (per `.claude/patterns/review-verdict-gate.md`):
   ```bash
   python3 .claude/scripts/run-review-verdict-gate.py .runs/agent-traces/ux-journeyer.json ux-journeyer
   ```
   This walks the trace's `per_step_reviews[]` (when present), enforces
   the `review_method → verdict` policy table from `.claude/agents/ux-journeyer.md`,
   and writes the `review_method_gate_evaluated: true` sentinel asserted
   by this state's VERIFY. Idempotent and safe to run unconditionally.
3. If `verdict` == `"blocked"`, this is a **hard gate failure** — the golden path cannot be completed. Report the blocked location to the user. Skip STATEs 4-5 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns).
4. If `unresolved_dead_ends` > 0, this is a **hard gate failure** — real dead ends remain after fixes. Skip STATEs 4-5 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns).
5. If `dead_ends` > 0 AND `unresolved_dead_ends` == 0, all dead ends are intentional fake-door pages. Note in verify report (informational, does not block).
6. Extract Fix Summaries from the agent's return message. Append each fix to `.runs/fix-log.md` with the prefix `Fix (ux-journeyer):`.

### Design-UX Merge (if scope is `full` or `visual`, AND archetype is `web-app`)

After both design-critic and ux-journeyer have completed and their builds pass:

1. Read both traces:
   - `.runs/agent-traces/design-critic.json`
   - `.runs/agent-traces/ux-journeyer.json`

2. Compute the quality gate verdict:
   - **fail**: design-critic verdict is `"unresolved"` OR ux-journeyer verdict is `"blocked"`
   - **warn**: ux-journeyer `dead_ends` > 0 (but design-critic passed)
   - **pass**: neither condition triggered

3. Write `.runs/design-ux-merge.json`:
   ```bash
   cat > .runs/design-ux-merge.json << 'DUXEOF'
   {"timestamp":"<ISO 8601>","verdict":"<pass|warn|fail>","design_critic":{"verdict":"<verdict>","min_score":<S>,"weakest_page":"<page>","sections_below_8":<B>,"fixes_applied":<F>,"unresolved_sections":<U>,"pre_existing_debt":<DEBT>},"ux_journeyer":{"verdict":"<verdict>","clicks_to_value":<C>,"dead_ends":<D>,"coverage_pct":<P>,"fixes_applied":<F>}}
   DUXEOF
   ```

**POSTCONDITIONS:** All scope-required Phase 2 traces exist. Build passes. `design-ux-merge.json` exists (when scope is `full` or `visual` AND archetype is `web-app`). fix-log.md has entries for each Phase 2 agent whose trace shows fixes array length > 0.

**VERIFY:**
```bash
python3 -c "import json,os; ctx=json.load(open('.runs/verify-context.json')); run_id=ctx.get('run_id',''); needs_ux=ctx.get('scope') in ('full','visual') and ctx.get('archetype')=='web-app'; assert not needs_ux or os.path.exists('.runs/agent-traces/ux-journeyer.json'), 'ux-journeyer.json missing (scope=%s, archetype=%s)' % (ctx.get('scope'),ctx.get('archetype')); assert not needs_ux or os.path.exists('.runs/design-ux-merge.json'), 'design-ux-merge.json missing'; assert (not needs_ux) or json.load(open('.runs/agent-traces/ux-journeyer.json')).get('review_method_gate_evaluated') is True, 'review-verdict-gate did not run on ux-journeyer trace (review_method_gate_evaluated sentinel missing)'; ledger=[json.loads(l) for l in open('.runs/fix-ledger.jsonl') if l.strip()] if os.path.exists('.runs/fix-ledger.jsonl') else None; by_agent={}; [by_agent.update({r.get('agent'): by_agent.get(r.get('agent'),0)+1}) for r in (ledger or []) if r.get('run_id')==run_id]; fl=open('.runs/fix-log.md').read() if os.path.exists('.runs/fix-log.md') else ''; checks=[('design-critic','.runs/agent-traces/design-critic.json'),('ux-journeyer','.runs/agent-traces/ux-journeyer.json'),('security-fixer','.runs/agent-traces/security-fixer.json')]; errs=[]
for n,p in checks:
    if not os.path.exists(p): continue
    tf=len(json.load(open(p)).get('fixes',[]))
    if tf==0: continue
    if ledger is not None:
        lf=by_agent.get(n,0)
        if lf!=tf: errs.append(n+': trace='+str(tf)+' ledger='+str(lf))
    else:
        if 'Fix ('+n not in fl: errs.append(n+': trace has fixes but fix-log missing Fix ('+n+')')
assert not errs, '; '.join(errs)"
```
Build command exited 0 after last Phase 2 agent.

> **Hook-enforced:** `skill-agent-gate.sh` validates STATE 3c postconditions before allowing security-fixer to spawn.

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 3c
```

**NEXT:** Read [state-3d-quality-fix.md](state-3d-quality-fix.md) to continue.
