# STATE 13: BUILD_VALIDATION

**PRECONDITIONS:**
- Externals done, BG2.5 PASS (STATE 12 POSTCONDITIONS met)

**ACTIONS:**

> **Archetype routing** (per `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table):
>
> | Concern | web-app | service | cli |
> |---------|---------|---------|-----|
> | Primary unit | page | endpoint | command |
> | Spec field | `golden_path` | `endpoints` | `commands` |
> | Skip | — | pages, landing, Fake Door | pages, API, landing, Fake Door |
> | Visual agents | full pipeline | skip | skip |
> | Analytics | client + server | server only | server only, opt-in |
>
> State-specific logic below takes precedence.

Run build and artifact-existence verification:

1. **Build**: run `npm run build` -- the project must compile
2. **Page/endpoint/command existence:** Verify each behavior's primary artifact exists per archetype. (Per `patterns/archetype-behavior-check.md`: web-app=`src/app/<page>/page.tsx` + landing, service=handler per framework stack file, cli=`src/commands/<cmd>.ts`)

If any check fails: fix directly (budget: 2 fix attempts). Re-run `npm run build` after fixes.
If still failing after 2 attempts: list all remaining errors and their file locations. Ask the user whether to (a) continue and fix later, or (b) stop and investigate now.

Write intermediate artifact:
```bash
python3 -c "
import json
json.dump({'build_pass': True, 'artifacts_verified': True}, open('.runs/bootstrap-build-validated.json', 'w'), indent=2)
print('Wrote .runs/bootstrap-build-validated.json')
"
```

**POSTCONDITIONS:**
- `npm run build` passes (exit code 0)
- All pages/endpoints/commands exist per archetype
- `.runs/bootstrap-build-validated.json` written

**VERIFY:**
```bash
npm run build --silent && test -f .runs/bootstrap-build-validated.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 13
```

**NEXT:** Read [state-13a-analytics-design-check.md](state-13a-analytics-design-check.md) to continue.
