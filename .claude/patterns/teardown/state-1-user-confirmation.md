# STATE 1: USER_CONFIRMATION

**PRECONDITIONS:**
- Pre-flight checks passed (STATE 0 POSTCONDITIONS met)
- Deploy manifest read and parsed

**ACTIONS:**

Present a summary:

```
## Teardown Plan

**Project:** <name>

**Resources to delete (in reverse order of creation):**
1. [If posthog] PostHog dashboard: #<dashboard_id>
2. [If stripe] Stripe webhook endpoint: <url>
3. [If hosting.domain] Custom domain: <domain>
4. [If hosting] Hosting project (<provider>): <project> — unlinks integrations
5. [If surface_url and no hosting] Surface project: <surface_url> — standalone surface deployment
6. [If database] Database project (<provider>): <ref/id> — permanent data loss
7. [If external_services] External services (manual): <list>

This action is irreversible. All data in the database will be permanently deleted.

To confirm, type the project name: **<name>**
```

**STOP.** Do not proceed until the user types the exact project name.

**POSTCONDITIONS:**
- User has typed the exact project name to confirm teardown

- **Record confirmation** in `teardown-context.json`:
  ```bash
  python3 -c "
  import json
  ctx = json.load(open('.runs/teardown-context.json'))
  ctx['confirmed'] = True
  json.dump(ctx, open('.runs/teardown-context.json', 'w'), indent=2)
  "
  ```

**VERIFY:**
```bash
python3 -c "import json; assert json.load(open('.runs/teardown-context.json')).get('confirmed') == True, 'confirmed not set'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh teardown 1
```

**NEXT:** Read [state-2-destroy-resources.md](state-2-destroy-resources.md) to continue.
