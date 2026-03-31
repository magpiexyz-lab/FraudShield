# STATE 4: HEALTH_CHECK

**PRECONDITIONS:**
- Infrastructure provisioned and deployed (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

### 5c: Health check

If archetype is `cli` (surface-only deployment): skip the `/api/health` check — CLI surfaces are static HTML pages with no API routes. Instead, verify the surface loads:
```bash
curl -s -o /dev/null -w "%{http_code}" <canonical_url>
```
If HTTP 200 -> proceed to Step 5e. If not -> report to the user:

> Surface returned HTTP <code>. Recovery options:
> 1. **Wait and retry** — DNS propagation can take 1-5 minutes after first deploy. Re-run the curl command above.
> 2. **Check hosting dashboard** — see the hosting stack file's `## Deploy Interface > Teardown` for the dashboard URL. Verify the deployment succeeded and the domain is configured.
> 3. **Redeploy** — re-run `/deploy` (it is idempotent — safe to repeat).
> 4. **Teardown and restart** — run `/teardown` to remove partial infrastructure, then retry `/deploy`.

Skip Step 5d (no services to auto-fix for static surfaces).

For all other archetypes:
```bash
curl -s <canonical_url>/api/health
```
Parse the JSON response. Each service returns `"ok"` or an error message.

If all checks pass -> proceed to Step 5d.5.

### 5d: Auto-fix (max 2 rounds)

If any health check fails, diagnose and attempt to fix:

| Check | Diagnosis | Auto-fix |
|-------|-----------|----------|
| `database` | Re-extract keys using database stack file's Provisioning steps. Compare with hosting stack file's `## Deploy Interface > Auto-Fix` verify command. | If mismatch: re-set env vars using hosting stack file's env var method, then redeploy |
| `auth` | Re-check auth config via database stack file's `## Deploy Interface > Auth Config` | Re-run the auth config step |
| `analytics` | Code integration issue — cannot fix via CLI | Report: "Analytics health check failed. This is likely a code issue — merge the current PR to `main`, pull (`git checkout main && git pull`), then run `/change fix analytics integration`." |
| `payment` | Verify webhook: `stripe webhook_endpoints list`. Check env var using hosting stack file's Auto-Fix verify command. | Re-set env vars if missing/wrong, redeploy |

After all fixable issues are addressed:
- If any env vars were changed -> batch into a single redeploy using the hosting stack file's `## Deploy Interface > Deploy` command
- Re-run health check: `curl -s <canonical_url>/api/health`

If still failing after 2 fix rounds -> report precise per-service diagnosis with actionable next steps.

### 5d.5: Provision scan (independent verification)

Spawn the `provision-scanner` agent (`subagent_type: provision-scanner`).
Pass context:

> Mode: deploy
> Manifest path: .claude/runs/deploy-manifest.json

Wait for the agent to complete. Include the scanner's output table in the Step 6 summary under a **Provision Scan** heading. If any check FAILs, list them as action items — the health check + auto-fix (5c-5d) already attempted remediation, so these are residual issues for the user to address.

### 5e: File template observations

If any fix during the deploy flow (Steps 3-5d) required working around a
problem whose root cause is in a template file (stack file, command file,
or pattern file), follow `.claude/patterns/observe.md` to file an
observation issue. This captures deployment-specific template gaps that
verify.md's build loop would not encounter.

Do NOT file observations for environmental issues (missing/mistyped env
vars, temporary network outages, uninitialized CLIs, or authentication
failures) — observe.md's trigger evaluation excludes these.

- **Write health check artifact** (`.claude/runs/deploy-health.json`):
  ```bash
  python3 -c "
  import json
  health = {
      'health_check_passed': True,
      'auto_fix_rounds': 0,
      'provision_scan_completed': True,
      'observations_filed': 0
  }
  json.dump(health, open('.claude/runs/deploy-health.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- Health check executed against canonical_url
- Auto-fix attempted if health check failed (max 2 rounds)
- Provision scan completed
- Template observations filed (if applicable)
- `.claude/runs/deploy-health.json` exists

**VERIFY:**
```bash
test -f .claude/runs/deploy-health.json
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh deploy 4
```

**NEXT:** Read [state-5-manifest-write.md](state-5-manifest-write.md) to continue.
