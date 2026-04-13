# STATE 3c: UX_MERGE

**PRECONDITIONS:** STATE 3b complete (design-critic.json merged, build and lint pass, lead Phase 1 fixes applied).

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Visual agents".
>
> web-app: spawn ux-journeyer, run Design-UX Merge | service: skip both | cli: skip both

### ux-journeyer (if scope is `full` or `visual`, AND archetype is `web-app`) — SERIAL

Spawn the `ux-journeyer` agent (`subagent_type: ux-journeyer`). Pass PR file boundary. **Wait for completion.**
After completion: verify `.runs/agent-traces/ux-journeyer.json` exists; if agent returned output but trace is missing, write a recovery trace with `"recovery":true`.
Run `npm run build`. If build fails, fix (max 2 attempts) before next agent.

#### Lead-side validation (ux-journeyer)

1. Read `.runs/agent-traces/ux-journeyer.json` trace.
2. If `verdict` == `"blocked"`, this is a **hard gate failure** — the golden path cannot be completed. Report the blocked location to the user. Skip STATEs 4-6 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns).
3. If `unresolved_dead_ends` > 0, this is a **hard gate failure** — real dead ends remain after fixes. Skip STATEs 4-6 but still write verify-report.md (STATE 7a) and execute STATE 8 (Save Patterns).
4. If `dead_ends` > 0 AND `unresolved_dead_ends` == 0, all dead ends are intentional fake-door pages. Note in verify report (informational, does not block).
5. Extract Fix Summaries from the agent's return message. Append each fix to `.runs/fix-log.md` with the prefix `Fix (ux-journeyer):`.

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
python3 -c "import json,os; fl=open('.runs/fix-log.md').read() if os.path.exists('.runs/fix-log.md') else ''; checks=[('design-critic','.runs/agent-traces/design-critic.json'),('ux-journeyer','.runs/agent-traces/ux-journeyer.json'),('security-fixer','.runs/agent-traces/security-fixer.json')]; errs=[n+': trace has fixes but fix-log missing Fix ('+n+')' for n,p in checks if os.path.exists(p) and len(json.load(open(p)).get('fixes',[]))>0 and 'Fix ('+n not in fl]; assert not errs, '; '.join(errs)"
```
Build command exited 0 after last Phase 2 agent.

> **Hook-enforced:** `skill-agent-gate.sh` validates STATE 3c postconditions before allowing security-fixer to spawn.

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 3c
```

**NEXT:** Read [state-4-security-merge-fix.md](state-4-security-merge-fix.md) to continue.
