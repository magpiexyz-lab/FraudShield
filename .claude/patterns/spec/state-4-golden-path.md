# STATE 4: GOLDEN_PATH

**PRECONDITIONS:**
- Behaviors derived (STATE 3 POSTCONDITIONS met)

**ACTIONS:**

Derive golden_path from behaviors. The format depends on the archetype:

**If type is `web-app`:**
```yaml
golden_path:
  - step: "<description>"         # e.g., "Visit landing page"
    event: visit_landing
    page: landing
  # Continue through behavior chain to value moment
  - step: "<value-delivering action>"
    event: activate
    page: <value page>
target_clicks: <N>
```

**If type is `service`:**
```yaml
endpoints:
  - path: "/<endpoint>"
    method: POST
    description: "<what this endpoint does>"
  # List all API endpoints from behaviors
golden_path:
  - step: "<description>"
    event: api_call
    endpoint: "/<endpoint>"
  - step: "<value-delivering action>"
    event: activate
    endpoint: "/<value endpoint>"
```

**If type is `cli`:**
```yaml
commands:
  - name: "<command>"
    description: "<what this command does>"
  # List all commands from behaviors
golden_path:
  - step: "<description>"
    event: command_run
    command: "<command>"
  - step: "<value-delivering action>"
    event: activate
    command: "<value command>"
```

- `step:` replaces the old `action:` field
- Pages are derived from golden_path — no separate `pages` section

**POSTCONDITIONS:**
- Golden path derived from behaviors
- Format matches archetype (web-app: pages, service: endpoints, cli: commands)
- Each step has step description, event, and page/endpoint/command

**VERIFY:**
```bash
grep -q 'golden_path:' experiment/experiment.yaml 2>/dev/null || grep -q 'endpoints:' experiment/experiment.yaml 2>/dev/null || grep -q 'commands:' experiment/experiment.yaml 2>/dev/null
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh spec 4
```

**NEXT:** Read [state-5-variants.md](state-5-variants.md) to continue.
