# STATE 0: READ_CONTEXT

**PRECONDITIONS:** None — this is the entry state.

**ACTIONS:**

1. Clean trace directory (removes stale traces from prior runs):
   ```bash
   rm -rf .claude/runs/agent-traces && mkdir -p .claude/runs/agent-traces
   ```

2. Read context files:
   - Read `experiment/experiment.yaml` — understand pages (from golden_path), behaviors, stack
   - Read `experiment/EVENTS.yaml` — understand tracked events
   - Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`)
   - If in bootstrap-verify or change-verify mode: read all files listed in current-plan.md `context_files`
   - If `stack.testing` is present in experiment.yaml, read `.claude/stacks/testing/<value>.md`

3. Determine skill name:
   - If `.claude/runs/current-plan.md` exists with a `skill:` field in its frontmatter → use that value (e.g., `"bootstrap"`, `"change"`, `"harden"`)
   - Otherwise → use `"verify"` (standalone mode)

4. Read previous verify baseline (if available), filtered by current skill:
   ```bash
   BASELINE_AVAILABLE=false
   if [[ -f .claude/runs/verify-history.jsonl ]]; then
     PREV_RUN=$(python3 -c "
   import json
   skill='<skill from step 3>'
   entries=[json.loads(l) for l in open('.claude/runs/verify-history.jsonl') if l.strip()]
   matching=[e for e in entries if e.get('skill','')==skill]
   print(json.dumps(matching[-1]) if matching else '')
   " 2>/dev/null || echo "")
     if [[ -n "$PREV_RUN" ]]; then
       BASELINE_AVAILABLE=true
     fi
   fi
   ```

5. Write `.claude/runs/verify-context.json` (includes `skill` for Q-score attribution, `run_id` for trace freshness validation, and `baseline_available` for delta reporting):
   ```bash
   cat > .claude/runs/verify-context.json << CTXEOF
   {"scope":"<scope>","archetype":"<type>","quality":"<quality|mvp>","skill":"<skill from step 3>","branch":"$(git branch --show-current)","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","run_id":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","baseline_available":$BASELINE_AVAILABLE,"completed_states":[0]}
   CTXEOF
   ```

6. Create `.claude/runs/fix-log.md` on disk:
   ```bash
   echo '# Error Fix Log' > .claude/runs/fix-log.md
   ```

7. Extract context digest (in-memory, passed to agents in STATE 2/3):
   - Pages: list all page names and routes (union of `golden_path` and filesystem scan of `src/app/**/page.tsx`, excluding `/api/`)
   - Behavior IDs: list all behavior IDs from `behaviors`
   - Event names: list event names from `experiment/EVENTS.yaml`
   - Source file list: `find src/ -type f \( -name '*.ts' -o -name '*.tsx' \) | head -100`
   - PR changed files: `git diff --name-only $(git merge-base HEAD main)...HEAD`
   - Golden path steps: ordered list of steps from `golden_path`

**POSTCONDITIONS:** All 4 artifacts exist on disk (agent-traces dir, verify-context.json with `skill` field, fix-log.md). Context digest is available in-memory. If `verify-history.jsonl` has a previous entry matching the current skill, baseline data is available for STATE 7 delta reporting.

**VERIFY:**
```bash
test -f .claude/runs/verify-context.json && test -f .claude/runs/fix-log.md && test -d .claude/runs/agent-traces
```

> **Hook-enforced:** `agent-state-gate.sh` validates these postconditions before allowing the next state's agents to spawn.

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 0
```

**NEXT:** Read [state-1-build-lint-loop.md](state-1-build-lint-loop.md) to continue.
