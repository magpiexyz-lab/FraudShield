# STATE 0: READ_CONTEXT

**PRECONDITIONS:** None — this is the entry state.

**ACTIONS:**

1. **Bootstrap check** (standalone mode only):
   If no `.runs/current-plan.md` exists (standalone `/verify`), check that the project is bootstrapped:
   ```bash
   test -f package.json && test -f experiment/experiment.yaml
   ```
   If either is missing, **STOP**: "No bootstrapped app found. Run `/bootstrap` first to scaffold the project from experiment.yaml."

2. Clean trace directory (removes stale traces from prior runs):
   ```bash
   rm -rf .runs/agent-traces && mkdir -p .runs/agent-traces
   ```

3. Read context files:
   - Read `experiment/experiment.yaml` — understand pages (from golden_path), behaviors, stack
   - Read `experiment/EVENTS.yaml` — understand tracked events
   - Read the archetype file at `.claude/archetypes/<type>.md` (type from experiment.yaml, default `web-app`)
   - If in bootstrap-verify or change-verify mode: read all files listed in current-plan.md `context_files`
   - If `stack.testing` is present in experiment.yaml, read `.claude/stacks/testing/<value>.md`

4. Determine skill name:
   - If `.runs/current-plan.md` exists with a `skill:` field in its frontmatter → use that value (e.g., `"bootstrap"`, `"change"`)
   - Otherwise → use `"verify"` (standalone mode)

5. Read previous verify baseline (if available), filtered by current skill:
   ```bash
   BASELINE_AVAILABLE=false
   if [[ -f .runs/verify-history.jsonl ]]; then
     PREV_RUN=$(python3 -c "
   import json
   skill='<skill from step 4>'
   entries=[json.loads(l) for l in open('.runs/verify-history.jsonl') if l.strip()]
   matching=[e for e in entries if e.get('skill','')==skill]
   print(json.dumps(matching[-1]) if matching else '')
   " 2>/dev/null || echo "")
     if [[ -n "$PREV_RUN" ]]; then
       BASELINE_AVAILABLE=true
     fi
   fi
   ```

6. Merge verify-specific fields into context via shared init script. Extra fields override base: `skill` attributes Q-scores to the calling skill, `scope`/`archetype`/`quality` drive agent gating, `mode` controls PR gate behavior, `baseline_available` enables delta reporting. Base fields (`branch`, `timestamp`, `run_id`, `completed_states`) are already set by lifecycle-init.sh:
   ```bash
   bash .claude/scripts/init-context.sh verify "{\"skill\":\"<skill from step 4>\",\"scope\":\"<scope>\",\"archetype\":\"<type>\",\"quality\":\"production\",\"mode\":\"<standalone if skill is verify, otherwise the skill name + -verify e.g. bootstrap-verify, change-verify>\",\"baseline_available\":$BASELINE_AVAILABLE}"
   ```

7. Create `.runs/fix-log.md` on disk:
   ```bash
   echo '# Error Fix Log' > .runs/fix-log.md
   ```

8. Extract context digest (in-memory, passed to agents in STATE 2/3):
   - Pages: list all page names and routes (union of `golden_path` and filesystem scan of `src/app/**/page.tsx`, excluding `/api/`)
   - Behavior IDs: list all behavior IDs from `behaviors`
   - Event names: list event names from `experiment/EVENTS.yaml`
   - Source file list: `find src/ -type f \( -name '*.ts' -o -name '*.tsx' \) | head -100`
   - PR changed files: `git diff --name-only $(git merge-base HEAD main)...HEAD`
   - Golden path steps: ordered list of steps from `golden_path`

**POSTCONDITIONS:** All 4 artifacts exist on disk (agent-traces dir, verify-context.json with `skill` field, fix-log.md). Context digest is available in-memory. If `verify-history.jsonl` has a previous entry matching the current skill, baseline data is available for STATE 7 delta reporting.

**VERIFY:**
```bash
test -f .runs/verify-context.json && test -f .runs/fix-log.md && test -d .runs/agent-traces && python3 -c "import json; assert json.load(open('.runs/verify-context.json')).get('skill'), 'skill field empty in verify-context.json'"
```

> **Hook-enforced:** `skill-agent-gate.sh` validates these postconditions before allowing the next state's agents to spawn.

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 0
```

**NEXT:** Read [state-1-build-lint-loop.md](state-1-build-lint-loop.md) to continue.
