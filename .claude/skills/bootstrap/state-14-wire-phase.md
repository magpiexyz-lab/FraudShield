# STATE 14: WIRE_PHASE

**PRECONDITIONS:**
- BG2 PASS, build passes (STATE 13c POSTCONDITIONS met)

**ACTIONS:**

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, rows "Trace field", "Spec field", "Primary unit".
>
> Trace field — web-app: pages_wired + api_routes_wired | service: api_routes_wired | cli: commands_wired
>
> State-specific logic below takes precedence.

Spawn a subagent via Agent with:
- subagent_type: scaffold-wire
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/wire.md` and execute Steps 5 through 8b ONLY.
     Do NOT run Step 8 (verify.md) or Step 9 (PR).
  2. Read context files before starting: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.runs/current-plan.md`, `.claude/archetypes/<type>.md`,
     all `.claude/stacks/<category>/<value>.md` for categories in experiment.yaml `stack`,
     `.claude/patterns/visual-review.md`,
     `.claude/patterns/security-review.md`,
     `.github/PULL_REQUEST_TEMPLATE.md`
  3. Include the completion reports from init, libs, pages, landing, and
     externals subagents (external dep decisions, generated files, env vars)
     in the prompt so the wire subagent has context
  4. Follow CLAUDE.md Rules 1, 4, 5, 6, 7, 8, 10, 12

Update checkpoint in `.runs/current-plan.md` frontmatter to `awaiting-verify`.

Check off in `.runs/current-plan.md`: `- [x] scaffold-wire completed`

Verify scaffold-wire trace: `test -f .runs/agent-traces/scaffold-wire.json && python3 -c "import json;d=json.load(open('.runs/agent-traces/scaffold-wire.json'));assert d.get('status')=='complete';print('scaffold-wire trace: OK')"`. If trace missing: log "WARN: scaffold-wire did not write trace -- continuing with file-based verification".

- **Write wire trace artifact** (`.runs/bootstrap-wire-trace.json`):
  ```bash
  python3 -c "
  import json, glob, os, yaml
  arch = yaml.safe_load(open('experiment/experiment.yaml')).get('type', 'web-app')
  trace = {'checkpoint': 'awaiting-verify'}
  if arch == 'web-app':
      trace['pages_wired'] = [os.path.relpath(os.path.dirname(f), 'src/app') for f in glob.glob('src/app/**/page.tsx', recursive=True) if '/api/' not in f]
      trace['api_routes_wired'] = [os.path.relpath(os.path.dirname(f), 'src/app/api') for f in glob.glob('src/app/api/**/route.ts', recursive=True)]
  elif arch == 'service':
      trace['pages_wired'] = []
      trace['api_routes_wired'] = [os.path.relpath(os.path.dirname(f), 'src/app/api') for f in glob.glob('src/app/api/**/route.ts', recursive=True)]
  elif arch == 'cli':
      trace['pages_wired'] = []
      trace['api_routes_wired'] = []
      trace['commands_wired'] = [os.path.splitext(os.path.basename(f))[0] for f in glob.glob('src/commands/*.ts')]
  json.dump(trace, open('.runs/bootstrap-wire-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- API routes created (if mutation behaviors exist) <!-- enforced by agent behavior, not VERIFY gate -->
- Wire integration complete <!-- enforced by agent behavior, not VERIFY gate -->
- Checkpoint updated to `awaiting-verify`
- `.runs/bootstrap-wire-trace.json` exists with wiring details

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.runs/bootstrap-wire-trace.json')); assert 'checkpoint' in d, 'checkpoint missing'; a=json.load(open('.runs/bootstrap-context.json')).get('archetype','web-app'); assert a!='web-app' or (isinstance(d.get('pages_wired'),list) and len(d['pages_wired'])>0), 'web-app: pages_wired empty or missing'; assert a!='service' or (isinstance(d.get('api_routes_wired'),list) and len(d['api_routes_wired'])>0), 'service: api_routes_wired empty or missing'; assert a!='cli' or (isinstance(d.get('commands_wired'),list) and len(d['commands_wired'])>0), 'cli: commands_wired empty or missing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 14
```

**NEXT:** Read [state-15-scan-and-classify.md](state-15-scan-and-classify.md) to continue.
