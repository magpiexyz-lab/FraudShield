# STATE 14: WIRE_PHASE

**PRECONDITIONS:**
- BG2 PASS, build passes (STATE 13 POSTCONDITIONS met)

**ACTIONS:**

Spawn a subagent via Agent with:
- subagent_type: scaffold-wire
- prompt: Tell the subagent to:
  1. Read `.claude/procedures/wire.md` and execute Steps 5 through 8b ONLY.
     Do NOT run Step 8 (verify.md) or Step 9 (PR).
  2. Read context files before starting: `experiment/experiment.yaml`, `experiment/EVENTS.yaml`,
     `.claude/runs/current-plan.md`, `.claude/archetypes/<type>.md`,
     all `.claude/stacks/<category>/<value>.md` for categories in experiment.yaml `stack`,
     `.claude/patterns/visual-review.md`,
     `.claude/patterns/security-review.md`,
     `.github/PULL_REQUEST_TEMPLATE.md`
  3. Include the completion reports from init, libs, pages, landing, and
     externals subagents (external dep decisions, generated files, env vars)
     in the prompt so the wire subagent has context
  4. Follow CLAUDE.md Rules 1, 4, 5, 6, 7, 8, 10, 12

Update checkpoint in `.claude/runs/current-plan.md` frontmatter to `awaiting-verify`.

Check off in `.claude/runs/current-plan.md`: `- [x] scaffold-wire completed`

Verify scaffold-wire trace: `test -f .claude/runs/agent-traces/scaffold-wire.json && python3 -c "import json;d=json.load(open('.claude/runs/agent-traces/scaffold-wire.json'));assert d.get('status')=='complete';print('scaffold-wire trace: OK')"`. If trace missing: log "WARN: scaffold-wire did not write trace -- continuing with file-based verification".

- **Write wire trace artifact** (`.claude/runs/bootstrap-wire-trace.json`):
  ```bash
  python3 -c "
  import json, glob, os
  trace = {
      'pages_wired': [os.path.dirname(f).split('/')[-1] for f in glob.glob('src/app/*/page.tsx')],
      'api_routes_wired': [os.path.dirname(f).split('/')[-1] for f in glob.glob('src/app/api/*/route.ts')],
      'checkpoint': 'awaiting-verify'
  }
  json.dump(trace, open('.claude/runs/bootstrap-wire-trace.json', 'w'), indent=2)
  "
  ```

**POSTCONDITIONS:**
- API routes created (if mutation behaviors exist)
- Wire integration complete
- Checkpoint updated to `awaiting-verify`
- `.claude/runs/bootstrap-wire-trace.json` exists with wiring details

**VERIFY:**
```bash
python3 -c "import json; d=json.load(open('.claude/runs/bootstrap-wire-trace.json')); assert 'checkpoint' in d, 'checkpoint missing'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh bootstrap 14
```

**NEXT:** Read [state-15-commit-and-push.md](state-15-commit-and-push.md) to continue.
