# STATE 3: EXECUTE

**PRECONDITIONS:**
- User approved rollback (STATE 2 POSTCONDITIONS met)

**ACTIONS:**

Execute the provider-specific rollback command from the hosting stack file.

If the provider only supports dashboard-based rollback (no CLI command), instruct the user to perform the rollback manually and wait for confirmation.

After rollback completes, run a health check. Read `experiment/experiment.yaml` to determine the archetype (`type` field, default: `web-app`):

- **web-app or service**: `curl -s <canonical_url>/api/health`
- **cli**: If `canonical_url` exists (surface page), `curl -s <canonical_url>`. Otherwise, skip -- CLI rollback only reverts the surface deployment; the CLI binary itself is distributed via package registries and cannot be "rolled back" via hosting.

If the health check fails, report the failure and suggest checking the hosting provider's dashboard for deployment logs.

Report the rollback result:

```
## Rollback Complete

**Status:** <success or failure>
**URL:** <canonical_url>
**Health check:** <pass or fail>

Warning: Database is NOT rolled back. If the incident involves data changes,
    see `.claude/patterns/incident-response.md` for database recovery.

**Next steps:**
- Investigate root cause
- Run `/change fix <description>` to fix the underlying issue
- Redeploy with `/deploy` after the fix is merged
```

### Q-score

Compute rollback quality (see `.claude/patterns/skill-scoring.md`):

```bash
RUN_ID=$(python3 -c "import json; print(json.load(open('.runs/rollback-context.json')).get('run_id', ''))" 2>/dev/null || echo "")
python3 -c "
import json, datetime
with open('.runs/q-dimensions.json', 'w') as f:
    json.dump({
        'skill': 'rollback',
        'scope': 'rollback',
        'dims': {'rollback': 1.0, 'completion': 1.0},
        'run_id': '$RUN_ID',
        'timestamp': datetime.datetime.now(datetime.timezone.utc).isoformat()
    }, f, indent=2)
print('Wrote .runs/q-dimensions.json')
" || true
```

**POSTCONDITIONS:**
- Rollback command executed (or user performed manual rollback)
- Health check attempted and result reported
- Rollback result summary presented to user

- **Write result artifact** (`.runs/rollback-result.json`):
  ```bash
  python3 -c "
  import json
  result = {
      'rollback_executed': True,
      'health_check_passed': True,
      'method': '<cli|manual>'
  }
  json.dump(result, open('.runs/rollback-result.json', 'w'), indent=2)
  "
  ```

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/rollback-result.json')); assert d.get('rollback_executed') is not None, 'rollback_executed missing'; assert d.get('health_check_passed') is not None, 'health_check_passed missing'; assert d.get('method') in ('cli','manual'), 'method must be cli or manual'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh rollback 3
```

**NEXT:** Skill states complete.
