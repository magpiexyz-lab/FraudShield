# STATE 3a: DESIGN_AGENTS

**PRECONDITIONS:** All Phase 1 traces exist (hook-enforced by `skill-agent-gate.sh`).

**ACTIONS:**

Spawn edit-capable agents ONE AT A TIME. Each must complete and pass `npm run build` before the next is spawned. This prevents write conflicts.

After each edit-capable agent completes, read its completion report and append its fixes to `.runs/fix-log.md`.

> **Shared algorithms:** Before each edit-capable agent spawn, execute [Atomic Execution Protocol](../verify.md#atomic-execution-protocol) snapshot. After each agent returns, use [Trace State Detection](../verify.md#trace-state-detection) and [Exhaustion Protocol](../verify.md#exhaustion-protocol) to handle the result.

### design-critic (if scope is `full` or `visual`, AND archetype is `web-app`) — PARALLEL PER PAGE

> REF: Archetype branching — see `.claude/patterns/archetype-behavior-check.md` Quick-Reference Table, row "Visual agents".
>
> web-app: design-critic (per-page parallel) | service: skip | cli: skip

#### Stage 1: Per-page review (parallel)

Discover **all** pages — not just golden_path pages:

1. Scan the filesystem for all page files:
   ```bash
   find src/app -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' -o -name 'page.js' 2>/dev/null | grep -v '/api/' | sort
   ```
2. Read `golden_path` pages from experiment.yaml for route metadata.
3. Merge: for each discovered page file, derive the route from its path (e.g., `src/app/settings/page.tsx` → `/settings`). Golden_path entries provide the canonical page name; filesystem-only pages use the directory name as the page name.
4. Deduplicate by route. The final list is the **union** of golden_path pages and filesystem pages.

Spawn **one design-critic agent per page**, ALL as parallel foreground Agent calls in a **SINGLE message**. Each agent prompt includes:
- Page name and route: "Review SINGLE page: `<page_name>` at route `<route>`."
- `base_url`: `http://localhost:3000` (from [Dev Server Preamble](../verify.md#dev-server-preamble-if-archetype-is-web-app))
- `run_id`: from verify-context.json
- Per-page file boundary with structured marker. Compute `PR_file_boundary ∩ src/app/<page>/**` — shared paths (`src/components/**`, `src/lib/**`) are explicitly EXCLUDED from per-page agents. Pass ONLY page-local files. Include in the prompt as a machine-parseable block:
  ```
  FILE_BOUNDARY_START
  src/app/<page>/page.tsx
  src/app/<page>/<page>-content.tsx
  FILE_BOUNDARY_END
  ```
  > **Hook-enforced:** `skill-agent-gate.sh` validates that no shared paths appear between these markers. The hook will BLOCK the agent spawn if shared paths are detected.
- Context digest summary
- Instruction to write trace as `design-critic-<page_name>.json`
- **Empty-boundary fast path**: If ALL files between `FILE_BOUNDARY_START` and `FILE_BOUNDARY_END`
  are empty (no page-local files in PR), execute a **fast-path review**: check whether any modified
  library files (`src/lib/**`) or shared components (`src/components/**`) from the full PR boundary
  are imported by this page. If no imports found, output `{"verdict":"pass","fast_path":true,
  "pages_reviewed":1,"min_score":10,"checks_performed":["import-chain-check"],"fixes_applied":0,
  "sections_below_8":0,"unresolved_sections":0}`. If imports found, fall back to standard
  screenshot + 8-criteria review for this page only.
- Shared-component reporting instruction:
  > When you find issues in files outside your FILE_BOUNDARY (shared components in
  > `src/components/` or `src/lib/`), record them in your trace:
  > - `"unresolved_shared": <count>` — number of unresolved issues in shared files
  > - `"shared_issues": [{"file": "...", "section": "...", "description": "..."}]`
  > Do NOT attempt to fix these files. They will be handled by a separate agent.

**Wait for all per-page agents to complete.**

After completion: use [Trace State Detection](../verify.md#trace-state-detection) to check **each** `design-critic-<page_name>.json` individually. If any agent is State 2 (exhausted), follow [Exhaustion Protocol](../verify.md#exhaustion-protocol) Tier 1 with reduced scope: "Focus on this page only." If State 1 (never started) and agent returned output, write a recovery trace.

#### Stage 1b: Orchestrator shared-component fixes (serial)

After all per-page agents complete AND before Stage 2 (consistency check):

1. Read each per-page trace. If any trace output mentions shared-component issues without fixing them (shared paths were excluded from boundary), the orchestrator applies those fixes serially, one file at a time.
2. Run `npm run build` after shared-component fixes. If build fails, fix (max 2 attempts).
3. Append each fix to `.runs/fix-log.md`: `Fix (design-critic-shared): <file> — <desc>`
4. If no shared-component issues reported: this step is a no-op.

#### Stage 1c: Shared-component design-critic agent (serial, conditional)

**Guard**: scope is `full` or `visual` AND archetype is `web-app` AND any per-page
trace has `unresolved_shared > 0` (shared-component issues reported but not fixed
because they were outside the per-page file boundary).

1. Collect reported-but-unfixed shared-component issues from all per-page traces:
   ```bash
   python3 -c "
   import json, glob
   issues = []
   for f in sorted(glob.glob('.runs/agent-traces/design-critic-*.json')):
       if 'design-critic-shared' in f: continue
       d = json.load(open(f))
       for si in d.get('shared_issues', []):
           issues.append(si)
   if issues: print(json.dumps(issues, indent=2))
   else: print('NONE')
   "
   ```
   If `NONE`: this step is a no-op. Skip to Stage 2.
2. Spawn a SINGLE `design-critic` agent (`subagent_type: design-critic`) with:
   - Trace name: `design-critic-shared.json`
   - File boundary: INVERTED — ONLY `src/components/**` and `src/lib/**` files from the PR boundary
     ```
     FILE_BOUNDARY_START
     src/components/...
     src/lib/...
     FILE_BOUNDARY_END
     ```
   - Input: the collected shared-component issues from step 1
   - Task: "Fix ONLY the shared-component visual issues reported by per-page agents. Do NOT perform a full design review — focus on the specific issues listed."
   - Include `run_id`, context digest, and agent-prompt-footer content
3. After completion: use [Trace State Detection](../verify.md#trace-state-detection) on `design-critic-shared.json`. If State 2 (exhausted), follow [Exhaustion Protocol](../verify.md#exhaustion-protocol) Tier 1 with reduced scope: "Fix only the highest-impact shared issue."
4. Run `npm run build`. If build fails, fix (max 2 attempts).
5. Append fixes to `.runs/fix-log.md`: `Fix (design-critic-shared): <file> — <desc>`

> **Hook-enforced:** `skill-agent-gate.sh` blocks `design-consistency-checker` spawn if per-page traces report shared-component issues but `design-critic-shared.json` does not exist.

**POSTCONDITIONS:**
- Per-page `design-critic-<page>.json` traces exist for all discovered pages (when scope is `full` or `visual` AND archetype is `web-app`)
- `design-critic-shared.json` exists if any per-page trace reported `unresolved_shared > 0`
- Build passes after all Stage 1/1b/1c fixes

**VERIFY:**
```bash
ls .runs/agent-traces/design-critic-*.json >/dev/null 2>&1 && python3 -c "import json,glob; fs=glob.glob('.runs/agent-traces/design-critic-*.json'); assert len(fs)>=1, 'no design-critic traces'; d=json.load(open(fs[0])); assert 'exit_code' in d or 'verdict' in d, 'design-critic trace missing exit_code or verdict'"
```

**STATE TRACKING:** After postconditions pass, mark this state complete:
```bash
bash .claude/scripts/advance-state.sh verify 3a
```

**NEXT:** Read [state-3b-quality-gate.md](state-3b-quality-gate.md) to continue.
